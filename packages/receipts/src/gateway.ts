// The MCP gateway: sits between an agent and one upstream MCP server, enforces scope + Cedar policy,
// and emits a signed, logged receipt for every tool call, allowed or denied.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { FactConfig, GatewayConfig } from "./config.ts";
import { digestOf, loadPrivateKey, loadPublicKey, type Envelope } from "./crypto.ts";
import { delegationValidAt, verifyDelegation, type Delegation } from "./delegation.ts";
import { createIssuer } from "./issue.ts";
import { openLog } from "./log-sink.ts";
import { upstreamSignatureOf } from "./upstream.ts";
import { evaluate, policyDigest, type PolicyDecision } from "./policy.ts";
import type { FactRecord, ReceiptPredicate } from "./receipt.ts";

export const GATEWAY_VERSION = "0.1.0";
export const RECEIPT_META_KEY = "agent-custody/receipt";
export const MODEL_META_KEY = "agent-custody/model";
/** Set by the gateway on the call it forwards upstream: the receipt id, and the agent and principal from the attested grant. */
export const AGENT_META_KEY = "agent-custody/agent";
export const PRINCIPAL_META_KEY = "agent-custody/principal";
/** Set by an upstream on its result: the ids of the facts it served in this call. The gateway remembers them for the session. */
export const FACTS_META_KEY = "agent-custody/facts";

export interface CallParams {
  name: string;
  arguments?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface Gateway {
  agentId: string;
  delegation: Delegation;
  listTools(): Promise<Tool[]>;
  handleCall(params: CallParams): Promise<CallToolResult>;
  close(): Promise<void>;
}

/** Returns null when an optional lookup references a call argument that is absent. */
function resolveFactArgs(template: Record<string, string>, args: Record<string, unknown>, optional = false): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(template)) {
    if (v.startsWith("$args.")) {
      const key = v.slice("$args.".length);
      if (!(key in args) || args[key] === undefined) {
        if (optional) return null;
        throw new Error(`fact argument "${k}" needs call argument "${key}", which is missing`);
      }
      out[k] = args[key];
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** First text content item, JSON-parsed when possible. Tool results carry no signature, so this is "observed", never "attested". */
function extractValue(result: CallToolResult): unknown {
  const text = result.content.find((c) => c.type === "text");
  if (!text || text.type !== "text") return null;
  try {
    return JSON.parse(text.text);
  } catch {
    return text.text;
  }
}

export async function createGateway(cfg: GatewayConfig): Promise<Gateway> {
  const gatewayKey = loadPrivateKey(cfg.identity.keyFile);
  const trusted = cfg.trustedPrincipalKeys.map(loadPublicKey);
  const grantEnvelope = JSON.parse(readFileSync(cfg.grantFile, "utf8")) as Envelope;
  const grant = verifyDelegation(grantEnvelope, trusted);
  if (!grant.ok) throw new Error(`delegation grant rejected: ${grant.error}`);
  if (!delegationValidAt(grant.delegation, new Date().toISOString())) throw new Error("delegation grant is outside its validity window");
  const delegation = grant.delegation;
  const principalKeyid = grant.keyid;

  const policyText = readFileSync(cfg.policyFile, "utf8");
  const pDigest = policyDigest(policyText);
  const issuer = createIssuer(gatewayKey, cfg.receiptsDir, openLog(cfg, gatewayKey));

  const upstream = new Client({ name: "agent-custody-gateway", version: GATEWAY_VERSION });
  if ("url" in cfg.upstream) {
    const token = cfg.upstream.tokenEnv ? process.env[cfg.upstream.tokenEnv] : undefined;
    if (cfg.upstream.tokenEnv && !token) throw new Error(`upstream token: environment variable ${cfg.upstream.tokenEnv} is not set`);
    await upstream.connect(new StreamableHTTPClientTransport(new URL(cfg.upstream.url), token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {}));
  } else {
    await upstream.connect(new StdioClientTransport({ command: cfg.upstream.command, args: cfg.upstream.args, env: cfg.upstream.env, stderr: "inherit" }));
  }

  const callUpstream = async (name: string, args: Record<string, unknown>, meta?: Record<string, string>): Promise<CallToolResult> =>
    (await upstream.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) })) as CallToolResult;

  async function gatherFacts(tool: string, args: Record<string, unknown>, meta: Record<string, string>): Promise<Record<string, FactRecord>> {
    const facts: Record<string, FactRecord> = {};
    for (const f of cfg.facts.filter((f: FactConfig) => f.forTools.includes(tool))) {
      const fargs = resolveFactArgs(f.args, args, f.optional);
      if (fargs === null) continue;
      // Lookups carry the same metadata as the forwarded call: they are the gateway acting for this receipt.
      const result = await callUpstream(f.tool, fargs, meta);
      if (result.isError) throw new Error(`fact "${f.name}" lookup via ${f.tool} failed: ${JSON.stringify(extractValue(result))}`);
      facts[f.name] = { tool: f.tool, args: fargs, value: extractValue(result), resultDigest: digestOf(result), provenance: "observed" };
    }
    return facts;
  }

  /** Every fact id an upstream has declared it served, in order of first sight. One gateway process is one agent session. */
  const consumed: string[] = [];
  const noteServedFacts = (result: CallToolResult) => {
    const ids = result._meta?.[FACTS_META_KEY];
    if (!Array.isArray(ids)) return;
    for (const id of ids) if (typeof id === "string" && !consumed.includes(id)) consumed.push(id);
  };

  async function handleCall(params: CallParams): Promise<CallToolResult> {
    const tool = params.name;
    const args = params.arguments ?? {};
    const receiptId = randomUUID();
    const timestamp = new Date().toISOString();
    const modelClaim = params._meta?.[MODEL_META_KEY];
    // What the agent had been shown before this call; recorded before this call's own result is seen.
    const consumedNow = [...consumed];
    const upstreamMeta = { [RECEIPT_META_KEY]: receiptId, [AGENT_META_KEY]: delegation.agent, [PRINCIPAL_META_KEY]: delegation.principal };

    let facts: Record<string, FactRecord> = {};
    let policy: PolicyDecision;
    let execution: ReceiptPredicate["execution"];

    if (!delegation.scopes.includes(tool)) {
      policy = { decision: "deny", reasons: [], errors: [`tool "${tool}" is not in the delegation scopes`], policyDigest: pDigest };
    } else {
      try {
        facts = await gatherFacts(tool, args, upstreamMeta);
        const factValues = Object.fromEntries(Object.entries(facts).map(([k, f]) => [k, f.value]));
        policy = evaluate(policyText, {
          agentId: delegation.agent,
          tool,
          context: { args, facts: factValues, grant: { principal: delegation.principal, scopes: delegation.scopes } },
        });
      } catch (e) {
        policy = { decision: "deny", reasons: [], errors: [String(e instanceof Error ? e.message : e)], policyDigest: pDigest };
      }
    }

    if (policy.decision === "allow") {
      try {
        // The upstream learns which receipt this call is, and who the grant says is calling. An upstream that keeps
        // state, such as the memory server, cites the receipt as the source of what it stores.
        const result = await callUpstream(tool, args, upstreamMeta);
        const upstreamSig = upstreamSignatureOf(result);
        execution = { status: result.isError ? "failed" : "executed", result, resultDigest: digestOf(result), provenance: "observed", ...(upstreamSig ? { upstream: { envelope: upstreamSig } } : {}) };
        noteServedFacts(result);
      } catch (e) {
        execution = { status: "error", error: String(e instanceof Error ? e.message : e), provenance: "observed" };
      }
    } else {
      execution = { status: "denied", reason: [...policy.reasons, ...policy.errors].join("; ") || "no permit policy matched", provenance: "observed" };
    }

    await issuer.issue({
      receiptId,
      timestamp,
      issuer: { kind: "gateway", keyid: issuer.keyid, version: GATEWAY_VERSION },
      principal: { id: delegation.principal, keyid: principalKeyid, provenance: "attested" },
      agent: { id: delegation.agent, provenance: "attested" },
      delegation: { envelope: grantEnvelope, provenance: "attested" },
      session: { id: null, toolUseId: null, provenance: "claimed" },
      model: { id: typeof modelClaim === "string" ? modelClaim : null, provenance: "claimed" },
      tool: { name: tool, provenance: "observed" },
      request: { args, argsDigest: digestOf(args), provenance: "claimed" },
      facts,
      consumed: { factIds: consumedNow, provenance: "observed" },
      policy: { ...policy, provenance: "observed" },
      execution,
    });

    const meta = { [RECEIPT_META_KEY]: receiptId };
    const refuse = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: `${text} (receipt ${receiptId})` }], _meta: meta });
    switch (execution.status) {
      case "denied":
        return refuse(`Denied by policy: ${execution.reason}`);
      case "error":
        return refuse(`Upstream error: ${execution.error}`);
      default: {
        const result = execution.result as CallToolResult;
        return { ...result, _meta: { ...result._meta, ...meta } };
      }
    }
  }

  return {
    agentId: delegation.agent,
    delegation,
    async listTools() {
      const { tools } = await upstream.listTools();
      return tools.filter((t) => delegation.scopes.includes(t.name));
    },
    handleCall,
    close: () => upstream.close(),
  };
}

/** Exposes the gateway as an MCP server over stdio. Everything diagnostic must go to stderr. */
export async function serveStdio(gw: Gateway): Promise<void> {
  const server = new Server({ name: "agent-custody-gateway", version: GATEWAY_VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await gw.listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => gw.handleCall(req.params as CallParams));
  await server.connect(new StdioServerTransport());
  await new Promise<void>((resolve) => {
    server.onclose = resolve;
  });
}

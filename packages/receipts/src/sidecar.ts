// The sidecar: the SDK issuer behind a local HTTP API, so agents written in any language can decide and record.
// Same config file, same receipts, same key. Everything it records is claimed, exactly as with the in-process SDK:
// the sidecar trusts what the agent's process tells it. Bind it to localhost; it is a per-host companion, not a service.
//   GET  /health                      -> { agentId, keyid, log: { kind, where } }
//   POST /decide  ToolEvent           -> PolicyDecision | null
//   POST /record  { event, outcome, policy? } -> ReceiptBundle, or 4xx/5xx with { error }
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Outcome, SdkIssuer, ToolEvent } from "./sdk/index.ts";
import type { PolicyDecision } from "./policy.ts";

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function parseEvent(v: unknown): ToolEvent {
  if (!isRecord(v) || typeof v.tool !== "string" || v.tool.length === 0) throw new Error("event needs a non-empty string tool");
  const args = isRecord(v.args) ? v.args : v.args === undefined ? {} : { input: v.args };
  const ev: ToolEvent = { tool: v.tool, args };
  if (typeof v.model === "string") ev.model = v.model;
  if (isRecord(v.session)) ev.session = { id: typeof v.session.id === "string" ? v.session.id : null, toolUseId: typeof v.session.toolUseId === "string" ? v.session.toolUseId : null };
  return ev;
}

function parseOutcome(v: unknown): Outcome {
  if (!isRecord(v) || typeof v.status !== "string") throw new Error("outcome needs a status");
  switch (v.status) {
    case "executed":
    case "failed":
      return { status: v.status, result: v.result ?? null };
    case "denied":
      return { status: "denied", reason: typeof v.reason === "string" ? v.reason : "denied" };
    case "error":
      return { status: "error", error: typeof v.error === "string" ? v.error : "error" };
    default:
      throw new Error(`unknown outcome status ${v.status}`);
  }
}

function parsePolicy(v: unknown): PolicyDecision | null {
  if (v === undefined || v === null) return null;
  if (!isRecord(v) || (v.decision !== "allow" && v.decision !== "deny") || !Array.isArray(v.reasons) || !Array.isArray(v.errors) || typeof v.policyDigest !== "string") throw new Error("policy must be a PolicyDecision from /decide");
  return { decision: v.decision, reasons: v.reasons.map(String), errors: v.errors.map(String), policyDigest: v.policyDigest };
}

export function sidecarHandler(issuer: SdkIssuer): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/health") return json(200, { agentId: issuer.agentId, keyid: issuer.keyid, log: { kind: issuer.log.kind, where: issuer.log.where } });
      if (req.method !== "POST") return json(404, { error: "not found" });
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(400, { error: "body must be JSON" });
      }
      if (url.pathname === "/decide") return json(200, issuer.decide(parseEvent(body)));
      if (url.pathname === "/record") {
        if (!isRecord(body)) return json(400, { error: "body must be {event, outcome, policy?}" });
        const bundle = await issuer.record(parseEvent(body.event), parseOutcome(body.outcome), parsePolicy(body.policy));
        return json(200, bundle);
      }
      return json(404, { error: "not found" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return json(/needs|must|unknown outcome/.test(msg) ? 400 : 502, { error: msg });
    }
  };
}

export interface RunningSidecar {
  url: string;
  close(): Promise<void>;
}

/** Starts the sidecar. Port 0 picks a free port. Host defaults to loopback on purpose. */
export function serveSidecar(issuer: SdkIssuer, opts: { port: number; host?: string }): Promise<RunningSidecar> {
  const host = opts.host ?? "127.0.0.1";
  const handler = sidecarHandler(issuer);
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(opts.port, host, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://${host}:${port}/`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

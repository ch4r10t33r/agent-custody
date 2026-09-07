// The memory server: the ledger as MCP tools, meant to run as an upstream of the receipts gateway.
// Behind the gateway every write and read is policy-checked and receipted, and the gateway tells this server, in the
// call's _meta, which receipt it is and who the attested grant says is calling. Those become the fact's source and
// actor; a caller cannot supply them. Run it directly and the source is null and the actor is whatever the caller
// claims, which is recorded as such.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Ledger } from "./ledger.ts";

export const SERVER_VERSION = "0.1.0";
/** The same keys the receipts gateway sets on the upstream call. Duplicated here so this package needs no runtime import from receipts. */
export const RECEIPT_META_KEY = "agent-custody/receipt";
export const AGENT_META_KEY = "agent-custody/agent";

const iso = z.string().datetime({ offset: true });
const Write = z.object({
  subject: z.string().min(1),
  predicate: z.string().min(1),
  value: z.unknown(),
  space: z.string().min(1),
  /** ignored behind the gateway, which supplies the attested agent instead */
  actor: z.string().min(1).optional(),
  validFrom: iso.optional(),
  confidence: z.number().min(0).max(1).optional(),
  supersedes: z.string().min(1).optional(),
});
const Read = z.object({ subject: z.string().min(1).optional(), predicate: z.string().min(1).optional(), space: z.string().min(1).optional(), validAt: iso.optional(), txAt: iso.optional(), includeClaimed: z.boolean().optional() });
const Confirm = z.object({ factId: z.string().min(1) });
const Retract = z.object({ factId: z.string().min(1), reason: z.string().min(1), actor: z.string().min(1).optional() });
const History = z.object({ factId: z.string().min(1) });

const str = { type: "string" as const };
export const TOOLS: Tool[] = [
  {
    name: "memory.write",
    description: "Record a belief: subject, predicate, value, in a space. Optionally supersede an earlier fact. Returns the new fact with its id, transaction time, actor, and source receipt.",
    inputSchema: { type: "object", properties: { subject: str, predicate: str, value: {}, space: str, actor: str, validFrom: str, confidence: { type: "number" }, supersedes: str }, required: ["subject", "predicate", "value", "space"] },
  },
  {
    name: "memory.read",
    description: "The facts believed at a moment. validAt asks whether a fact was true then; txAt asks whether the ledger knew it then. Both default to now. Filter by space, subject, predicate. Quarantined (claimed, unconfirmed) facts are left out unless includeClaimed is true.",
    inputSchema: { type: "object", properties: { subject: str, predicate: str, space: str, validAt: str, txAt: str, includeClaimed: { type: "boolean" } } },
  },
  {
    name: "memory.confirm",
    description: "Lift a quarantined (claimed) fact to attested. Only accepted through the gateway, so the confirming actor is the one named in the signed grant.",
    inputSchema: { type: "object", properties: { factId: str }, required: ["factId"] },
  },
  {
    name: "memory.retract",
    description: "Undo a belief: the fact leaves the present, stays visible to questions about the past, and whatever it superseded is believed again.",
    inputSchema: { type: "object", properties: { factId: str, reason: str, actor: str }, required: ["factId", "reason"] },
  },
  {
    name: "memory.history",
    description: "Every event that touched a fact, oldest first.",
    inputSchema: { type: "object", properties: { factId: str }, required: ["factId"] },
  },
];

export interface MemoryServerOptions {
  /** Refuse calls that did not come through the gateway, i.e. carry no receipt id. On by default when served from the CLI. */
  requireGateway?: boolean;
}

const json = (v: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
const fail = (msg: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: msg }] });

export function createMemoryServer(ledger: Ledger, opts: MemoryServerOptions = {}): Server {
  const server = new Server({ name: "agent-custody-memory", version: SERVER_VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const meta = (req.params._meta ?? {}) as Record<string, unknown>;
    const receiptId = typeof meta[RECEIPT_META_KEY] === "string" ? (meta[RECEIPT_META_KEY] as string) : null;
    const gatewayAgent = typeof meta[AGENT_META_KEY] === "string" ? (meta[AGENT_META_KEY] as string) : null;
    if (opts.requireGateway && !receiptId) return fail("memory server accepts calls only through the receipts gateway; no receipt id on this call");
    const args = req.params.arguments ?? {};
    const actorFor = (claimed: string | undefined) => gatewayAgent ?? claimed ?? "anonymous";
    // A write is attested when it came through the gateway: the actor is from a signed grant and the receipt exists.
    const provenance = receiptId && gatewayAgent ? "attested" : "claimed";
    try {
      switch (req.params.name) {
        case "memory.write": {
          const a = Write.parse(args);
          const ev = ledger.assert({ subject: a.subject, predicate: a.predicate, value: a.value ?? null, space: a.space, actor: actorFor(a.actor), source: { receiptId }, provenance, ...(a.validFrom ? { validFrom: a.validFrom } : {}), ...(a.confidence !== undefined ? { confidence: a.confidence } : {}), ...(a.supersedes ? { supersedes: a.supersedes } : {}) });
          return json({ fact: ev.fact, eventId: ev.eventId, txTime: ev.txTime, supersedes: ev.supersedes });
        }
        case "memory.read": {
          const { includeClaimed, ...q } = Read.parse(args);
          return json({ facts: ledger.asOf({ ...q, include: includeClaimed ? "all" : "attested" }) });
        }
        case "memory.retract": {
          const a = Retract.parse(args);
          const ev = ledger.retract({ factId: a.factId, actor: actorFor(a.actor), reason: a.reason, source: { receiptId } });
          return json({ eventId: ev.eventId, factId: ev.factId, txTime: ev.txTime, actor: ev.actor, reason: ev.reason, source: ev.source });
        }
        case "memory.confirm": {
          if (provenance !== "attested") return fail("confirmation must come through the receipts gateway; a self-reported caller cannot lift a fact out of quarantine");
          const a = Confirm.parse(args);
          const ev = ledger.confirm({ factId: a.factId, actor: actorFor(undefined), source: { receiptId } });
          return json({ eventId: ev.eventId, factId: ev.factId, txTime: ev.txTime, actor: ev.actor, source: ev.source });
        }
        case "memory.history":
          return json({ events: ledger.history(History.parse(args).factId) });
        default:
          return fail(`unknown tool ${req.params.name}`);
      }
    } catch (e) {
      return fail(e instanceof z.ZodError ? `invalid arguments: ${e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}` : String(e instanceof Error ? e.message : e));
    }
  });
  return server;
}

/** Serves over stdio, the way the gateway spawns it. Diagnostics must go to stderr. */
export async function serveStdio(server: Server): Promise<void> {
  await server.connect(new StdioServerTransport());
  await new Promise<void>((resolve) => {
    server.onclose = resolve;
  });
}

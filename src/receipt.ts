// The receipt: an in-toto Statement whose predicate records one tool call with per-field provenance.
import type { Envelope } from "./crypto.ts";
import type { InclusionProof } from "./log.ts";
import type { PolicyDecision } from "./policy.ts";

export const RECEIPT_TYPE = "application/vnd.in-toto+json";
export const RECEIPT_PREDICATE_TYPE = "https://agent-receipts.dev/receipt/v0.1";
export const TREEHEAD_TYPE = "application/vnd.agent-receipts.treehead+json";

/**
 * Provenance of a receipt field. This is the honest part of the design.
 *  - attested: signed by a key other than the gateway's (today: the principal's delegation key)
 *  - observed: the gateway itself obtained this deterministically (an upstream tool result, a policy evaluation)
 *  - claimed:  originates from the agent or model with no independent check (tool arguments, model id)
 */
export type Provenance = "attested" | "observed" | "claimed";

export interface FactRecord {
  tool: string;
  args: Record<string, unknown>;
  value: unknown;
  resultDigest: string;
  provenance: "observed";
}

export interface ReceiptPredicate {
  receiptId: string;
  timestamp: string;
  gateway: { keyid: string; version: string };
  principal: { id: string; keyid: string; provenance: "attested" };
  agent: { id: string; provenance: "attested" };
  delegation: { envelope: Envelope; provenance: "attested" };
  model: { id: string | null; provenance: "claimed" };
  tool: { name: string; provenance: "observed" };
  request: { args: Record<string, unknown>; argsDigest: string; provenance: "claimed" };
  facts: Record<string, FactRecord>;
  policy: PolicyDecision & { provenance: "observed" };
  execution:
    | { status: "executed" | "failed"; result: unknown; resultDigest: string; provenance: "observed" }
    | { status: "denied"; reason: string; provenance: "observed" }
    | { status: "error"; error: string; provenance: "observed" };
}

export interface ReceiptStatement {
  _type: "https://in-toto.io/Statement/v1";
  subject: { name: string; digest: { sha256: string } }[];
  predicateType: typeof RECEIPT_PREDICATE_TYPE;
  predicate: ReceiptPredicate;
}

export interface TreeHead {
  treeSize: number;
  rootHash: string;
  timestamp: string;
}

/** What gets written to disk and handed to a verifier. Self-contained apart from public keys. */
export interface ReceiptBundle {
  envelope: Envelope; // signed ReceiptStatement
  treeHead: Envelope; // signed TreeHead
  inclusion: InclusionProof;
}

export function buildStatement(p: ReceiptPredicate): ReceiptStatement {
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: `tool-call:${p.tool.name}:${p.receiptId}`, digest: { sha256: p.request.argsDigest } }],
    predicateType: RECEIPT_PREDICATE_TYPE,
    predicate: p,
  };
}

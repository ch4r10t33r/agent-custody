// The receipt: an in-toto Statement whose predicate records one tool call with per-field provenance.
import type { Envelope } from "./crypto.ts";
import type { InclusionProof } from "./log.ts";
import type { PolicyDecision } from "./policy.ts";

export const RECEIPT_TYPE = "application/vnd.in-toto+json";
export const RECEIPT_PREDICATE_TYPE = "https://agent-custody.dev/receipt/v0.2";
export const TREEHEAD_TYPE = "application/vnd.agent-custody.treehead+json";

/**
 * Provenance of a receipt field. This is the honest part of the design.
 *  - attested: signed by a key other than the issuer's (today: the principal's delegation key)
 *  - observed: the issuer obtained this deterministically, outside the agent's control (gateway only)
 *  - claimed:  originates from the agent, the model, or the agent's own process, with no independent check
 */
export type Provenance = "attested" | "observed" | "claimed";

/**
 * Who produced the receipt. This is the first thing a verifier should read.
 *  - gateway: an out-of-process enforcement point; the agent could neither skip nor forge it
 *  - sdk:     an interceptor inside the agent's own process; self-reported, tamper-evident after issue but not before
 */
export type IssuerKind = "gateway" | "sdk";

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
  issuer: { kind: IssuerKind; keyid: string; version: string; framework?: string };
  principal: { id: string; keyid: string; provenance: "attested" } | { id: string | null; provenance: "claimed" };
  agent: { id: string; provenance: Provenance };
  /** Present on gateway receipts. Absent when the issuer had no signed grant to check against. */
  delegation?: { envelope: Envelope; provenance: "attested" };
  /** Correlation ids from the host, when it supplied any. Never checked, always claimed. */
  session: { id: string | null; toolUseId: string | null; provenance: "claimed" };
  model: { id: string | null; provenance: "claimed" };
  tool: { name: string; provenance: Provenance };
  request: { args: Record<string, unknown>; argsDigest: string; provenance: "claimed" };
  facts: Record<string, FactRecord>;
  /**
   * Fact ids the agent had been shown, through this gateway, by the time of this call: every id an upstream declared
   * in its result _meta under "agent-custody/facts" on an earlier call in the session. Observed, because the gateway
   * saw those results itself. Absent on SDK receipts. This is what the agent relied on, as an upper bound.
   */
  consumed?: { factIds: string[]; provenance: "observed" };
  /** null when the issuer evaluated no policy. */
  policy: (PolicyDecision & { provenance: Provenance }) | null;
  execution:
    | { status: "executed" | "failed"; result: unknown; resultDigest: string; provenance: Provenance }
    | { status: "denied"; reason: string; provenance: Provenance }
    | { status: "error"; error: string; provenance: Provenance };
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

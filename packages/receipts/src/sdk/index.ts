// The interceptor SDK: issues receipts from inside the agent's own process.
// Everything it records is "claimed", because the issuer shares a process with the agent. The receipt says so.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SdkConfig } from "../config.ts";
import { digestOf, loadPrivateKey } from "../crypto.ts";
import { createIssuer } from "../issue.ts";
import { evaluate, type PolicyDecision } from "../policy.ts";
import type { ReceiptBundle, ReceiptPredicate } from "../receipt.ts";

export const SDK_VERSION = "0.1.0";

export interface ToolEvent {
  tool: string;
  args: Record<string, unknown>;
  model?: string | null;
  session?: { id?: string | null; toolUseId?: string | null };
}

export type Outcome =
  | { status: "executed" | "failed"; result: unknown }
  | { status: "denied"; reason: string }
  | { status: "error"; error: string };

export interface SdkIssuer {
  agentId: string;
  keyid: string;
  /** Evaluates the configured policy for a call. Returns null when no policy is configured. */
  decide(ev: ToolEvent): PolicyDecision | null;
  /** Issues one receipt for a completed, failed, denied, or errored call. */
  record(ev: ToolEvent, outcome: Outcome, policy?: PolicyDecision | null): ReceiptBundle;
  /** Wraps a tool function: decide, run, record. Throws PolicyDeniedError on deny, after issuing the denial receipt. */
  wrap<A extends Record<string, unknown>, R>(tool: string, fn: (args: A) => R | Promise<R>, meta?: Omit<ToolEvent, "tool" | "args">): (args: A) => Promise<R>;
}

export class PolicyDeniedError extends Error {
  readonly tool: string;
  readonly reason: string;
  readonly receiptId: string;
  constructor(tool: string, reason: string, receiptId: string) {
    super(`Denied by policy: ${reason} (receipt ${receiptId})`);
    this.name = "PolicyDeniedError";
    this.tool = tool;
    this.reason = reason;
    this.receiptId = receiptId;
  }
}

export function createSdkIssuer(cfg: SdkConfig): SdkIssuer {
  const key = loadPrivateKey(cfg.identity.keyFile);
  const issuer = createIssuer(key, cfg.receiptsDir, cfg.logFile);
  const policyText = cfg.policyFile ? readFileSync(cfg.policyFile, "utf8") : null;

  const decide = (ev: ToolEvent): PolicyDecision | null =>
    policyText === null ? null : evaluate(policyText, { agentId: cfg.agentId, tool: ev.tool, context: { args: ev.args, facts: {} } });

  function record(ev: ToolEvent, outcome: Outcome, policy: PolicyDecision | null = null): ReceiptBundle {
    const execution: ReceiptPredicate["execution"] =
      outcome.status === "denied"
        ? { status: "denied", reason: outcome.reason, provenance: "claimed" }
        : outcome.status === "error"
          ? { status: "error", error: outcome.error, provenance: "claimed" }
          : { status: outcome.status, result: outcome.result, resultDigest: digestOf(outcome.result), provenance: "claimed" };
    return issuer.issue({
      receiptId: randomUUID(),
      timestamp: new Date().toISOString(),
      issuer: { kind: "sdk", keyid: issuer.keyid, version: SDK_VERSION, ...(cfg.framework ? { framework: cfg.framework } : {}) },
      principal: { id: cfg.principalId ?? null, provenance: "claimed" },
      agent: { id: cfg.agentId, provenance: "claimed" },
      session: { id: ev.session?.id ?? null, toolUseId: ev.session?.toolUseId ?? null, provenance: "claimed" },
      model: { id: ev.model ?? null, provenance: "claimed" },
      tool: { name: ev.tool, provenance: "claimed" },
      request: { args: ev.args, argsDigest: digestOf(ev.args), provenance: "claimed" },
      facts: {},
      policy: policy ? { ...policy, provenance: "claimed" } : null,
      execution,
    });
  }

  return {
    agentId: cfg.agentId,
    keyid: issuer.keyid,
    decide,
    record,
    wrap(tool, fn, meta = {}) {
      return async (args) => {
        const ev: ToolEvent = { tool, args, ...meta };
        const policy = decide(ev);
        if (policy && policy.decision === "deny") {
          const reason = [...policy.reasons, ...policy.errors].join("; ") || "no permit policy matched";
          const bundle = record(ev, { status: "denied", reason }, policy);
          throw new PolicyDeniedError(tool, reason, receiptIdOf(bundle));
        }
        try {
          const result = await fn(args);
          record(ev, { status: "executed", result }, policy);
          return result;
        } catch (e) {
          record(ev, { status: "error", error: e instanceof Error ? e.message : String(e) }, policy);
          throw e;
        }
      };
    },
  };
}

export function receiptIdOf(bundle: ReceiptBundle): string {
  const st = JSON.parse(Buffer.from(bundle.envelope.payload, "base64").toString()) as { predicate: { receiptId: string } };
  return st.predicate.receiptId;
}

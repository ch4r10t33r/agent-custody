// Cedar policy evaluation. Fails closed: any evaluation error is a deny.
import * as cedar from "@cedar-policy/cedar-wasm/nodejs";
import { sha256Hex } from "./crypto.ts";

export interface PolicyDecision {
  decision: "allow" | "deny";
  /** ids of policies that determined the decision */
  reasons: string[];
  /** evaluation errors; non-empty always yields deny */
  errors: string[];
  policyDigest: string;
}

export interface PolicyRequest {
  agentId: string;
  tool: string;
  /** Cedar context. Numbers must be integers; Cedar has no floats. */
  context: Record<string, unknown>;
}

export function policyDigest(policyText: string): string {
  return sha256Hex(policyText);
}

export function evaluate(policyText: string, req: PolicyRequest): PolicyDecision {
  const digest = policyDigest(policyText);
  const answer = cedar.isAuthorized({
    principal: { type: "Agent", id: req.agentId },
    action: { type: "Action", id: req.tool },
    resource: { type: "Tool", id: req.tool },
    context: req.context as cedar.Context,
    policies: { staticPolicies: policyText },
    entities: [],
  });
  if (answer.type === "failure") {
    return { decision: "deny", reasons: [], errors: answer.errors.map((e) => e.message), policyDigest: digest };
  }
  const { decision, diagnostics } = answer.response;
  const errors = diagnostics.errors.map((e) => `${e.policyId}: ${e.error.message}`);
  return {
    decision: errors.length > 0 ? "deny" : decision,
    reasons: diagnostics.reason,
    errors,
    policyDigest: digest,
  };
}

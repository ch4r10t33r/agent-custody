import { describe, expect, it } from "vitest";
import { evaluate, policyDigest } from "../src/policy.ts";
import { POLICY } from "../scripts/fixture.ts";

const req = (tool: string, args: Record<string, unknown>, facts: Record<string, unknown> = {}) => ({
  agentId: "support-agent",
  tool,
  context: { args, facts, grant: { principal: "user_456", scopes: ["customer.lookup", "stripe.refund"] } },
});

describe("Cedar policy", () => {
  it("permits a refund under the limit for a verified customer", () => {
    const d = evaluate(POLICY, req("stripe.refund", { customer_id: "cust_123", amount: 50000 }, { customer: { verified: true } }));
    expect(d.decision).toBe("allow");
    expect(d.reasons.length).toBe(1);
    expect(d.errors).toEqual([]);
  });

  it("denies a refund over the limit", () => {
    expect(evaluate(POLICY, req("stripe.refund", { customer_id: "cust_123", amount: 100001 }, { customer: { verified: true } })).decision).toBe("deny");
  });

  it("denies when the verified fact is absent, so the agent cannot assert it via args", () => {
    const d = evaluate(POLICY, req("stripe.refund", { customer_id: "cust_123", amount: 1, customer: { verified: true } }));
    expect(d.decision).toBe("deny");
  });

  it("fails closed on evaluation errors such as a float amount, and reports them", () => {
    const d = evaluate(POLICY, req("stripe.refund", { customer_id: "cust_123", amount: 12.5 }, { customer: { verified: true } }));
    expect(d.decision).toBe("deny");
    expect(d.errors.length).toBeGreaterThan(0);
  });

  it("digest changes when the policy text changes, so receipts pin the exact policy", () => {
    expect(policyDigest(POLICY)).not.toBe(policyDigest(POLICY + "\n"));
    expect(evaluate(POLICY, req("customer.lookup", {})).policyDigest).toBe(policyDigest(POLICY));
  });
});

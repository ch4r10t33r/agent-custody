// Every ```cedar block in docs/policies.md must parse, and the behaviour the prose promises must hold.
// Blocks are addressed by position, so editing the doc without updating this test fails loudly.
import { readFileSync } from "node:fs";
import * as cedar from "@cedar-policy/cedar-wasm/nodejs";
import { describe, expect, it } from "vitest";
import { evaluate } from "../src/policy.ts";

const doc = readFileSync(new URL("../docs/policies.md", import.meta.url), "utf8");
const blocks = [...doc.matchAll(/```cedar\n([\s\S]*?)```/g)].map((m) => m[1]!);

const grant = { principal: "user_456", scopes: ["customer.lookup", "stripe.refund", "github.merge"] };
const req = (tool: string, args: Record<string, unknown>, facts: Record<string, unknown> = {}, agentId = "support-agent") => ({
  agentId,
  tool,
  context: { args, facts, grant },
});
const decide = (i: number, r: ReturnType<typeof req>) => evaluate(blocks[i]!, r).decision;

describe("docs/policies.md examples", () => {
  it("contains the expected number of examples", () => {
    expect(blocks.length).toBe(9);
  });

  it("every block parses as a Cedar policy set", () => {
    for (const [i, b] of blocks.entries()) {
      const r = cedar.checkParsePolicySet({ staticPolicies: b });
      expect(r.type, `block ${i}:\n${b}`).toBe("success");
    }
  });

  it("0: read permitted, anything else denied by default", () => {
    expect(decide(0, req("customer.lookup", {}))).toBe("allow");
    expect(decide(0, req("stripe.refund", { amount: 1 }))).toBe("deny");
  });

  it("1: amount cap, and a missing amount is an error hence deny", () => {
    expect(decide(1, req("stripe.refund", { amount: 100000 }))).toBe("allow");
    expect(decide(1, req("stripe.refund", { amount: 100001 }))).toBe("deny");
    const d = evaluate(blocks[1]!, req("stripe.refund", {}));
    expect(d.decision).toBe("deny");
    expect(d.errors[0]).toMatch(/amount/);
  });

  it("2: requires the gateway-observed fact; agent-asserted args do nothing", () => {
    expect(decide(2, req("stripe.refund", { amount: 1 }, { customer: { verified: true } }))).toBe("allow");
    expect(decide(2, req("stripe.refund", { amount: 1, verified: true }))).toBe("deny");
    expect(decide(2, req("stripe.refund", { amount: 1 }, { customer: { verified: false } }))).toBe("deny");
  });

  it("3: named agent only", () => {
    expect(decide(3, req("stripe.refund", {}))).toBe("allow");
    expect(decide(3, req("stripe.refund", {}, {}, "other-agent"))).toBe("deny");
  });

  it("4: action set", () => {
    expect(decide(4, req("customer.lookup", {}))).toBe("allow");
    expect(decide(4, req("stripe.refund", {}))).toBe("deny");
  });

  it("5: forbid overrides permit", () => {
    expect(decide(5, req("stripe.refund", { amount: 1 }, { customer: { flagged: false } }))).toBe("allow");
    expect(decide(5, req("stripe.refund", { amount: 1 }, { customer: { flagged: true } }))).toBe("deny");
  });

  it("6: like pattern on a string argument", () => {
    expect(decide(6, req("github.merge", { repo: "acme/api", base: "main" }))).toBe("allow");
    expect(decide(6, req("github.merge", { repo: "evil/api", base: "main" }))).toBe("deny");
    expect(decide(6, req("github.merge", { repo: "acme/api", base: "dev" }))).toBe("deny");
  });

  it("7: unless clause", () => {
    expect(decide(7, req("stripe.refund", { currency: "GBP" }))).toBe("allow");
    expect(decide(7, req("stripe.refund", { currency: "USD" }))).toBe("deny");
  });

  it("8: grant is reachable from context", () => {
    expect(decide(8, req("stripe.refund", {}))).toBe("allow");
    expect(evaluate(blocks[8]!, { ...req("stripe.refund", {}), context: { args: {}, facts: {}, grant: { ...grant, principal: "someone-else" } } }).decision).toBe("deny");
  });
});

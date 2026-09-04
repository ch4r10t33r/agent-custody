// Aspect: policies. Source: src/policy.ts, docs/policies.md
// Run:    npx tsx examples/03-policies.ts
//
// Policies are Cedar. The gateway maps a tool call to principal Agent::"<agent>", action Action::"<tool>",
// resource Tool::"<tool>", and a context with three parts: args (what the agent sent, claimed), facts (what the
// gateway fetched itself, observed), grant (from the signed delegation, attested). Default deny. Errors deny.
import { evaluate, policyDigest } from "../src/policy.ts";
import { step } from "./_out.ts";

const policy = `
// reads are fine for anyone holding the scope
permit(principal, action == Action::"customer.lookup", resource);

// refunds: at most £1,000 in pence, and only when the gateway itself saw the customer as verified
permit(principal, action == Action::"stripe.refund", resource)
when {
  context.args.amount <= 100000 &&
  context.facts has customer &&
  context.facts.customer.verified == true
};

// a hard block no permit can override
forbid(principal, action == Action::"stripe.refund", resource)
when { context.facts has customer && context.facts.customer.flagged == true };
`;

const grant = { principal: "user_456", scopes: ["customer.lookup", "stripe.refund"] };
const call = (tool: string, args: Record<string, unknown>, facts: Record<string, unknown> = {}) => {
  const d = evaluate(policy, { agentId: "support-agent", tool, context: { args, facts, grant } });
  return `${d.decision.padEnd(5)} reasons=[${d.reasons.join(",")}]${d.errors.length ? ` errors=[${d.errors.join(" | ")}]` : ""}`;
};

step(1, "a read: permitted by the first policy");
console.log("  ", call("customer.lookup", { customer_id: "cust_123" }));

step(2, "a refund under the limit to a customer the gateway verified");
console.log("  ", call("stripe.refund", { customer_id: "cust_123", amount: 50000 }, { customer: { verified: true, flagged: false } }));

step(3, "the same refund over the limit");
console.log("  ", call("stripe.refund", { customer_id: "cust_123", amount: 500000 }, { customer: { verified: true, flagged: false } }));

step(4, "the agent asserts verified=true in its arguments; the policy never reads args.verified, so nothing changes");
console.log("  ", call("stripe.refund", { customer_id: "cust_999", amount: 100, verified: true }, { customer: { verified: false, flagged: false } }));

step(5, "a flagged customer: the forbid wins even though the permit matched");
console.log("  ", call("stripe.refund", { customer_id: "cust_123", amount: 100 }, { customer: { verified: true, flagged: true } }));

step(6, "a float amount is not a Cedar value; the evaluation error is recorded and the decision is deny");
console.log("  ", call("stripe.refund", { customer_id: "cust_123", amount: 12.5 }, { customer: { verified: true, flagged: false } }));

step(7, "a tool nobody wrote a policy for: default deny");
console.log("  ", call("stripe.payout", { amount: 1 }));

step(8, "every receipt pins the policy by digest, so a verifier knows which text decided");
console.log("   policy digest:", policyDigest(policy));

console.log("\nOK");

# Writing policies

Policies are written in [Cedar](https://www.cedarpolicy.com/), the language AWS uses for AgentCore and Verified Permissions. There is no home-grown policy language here. Every example on this page is executed against the real evaluator in the test suite.

## How a tool call becomes a Cedar request

For an intercepted call to tool `T` by the agent named in the grant:

| Cedar slot | value |
| --- | --- |
| `principal` | `Agent::"<agent id from the grant>"` |
| `action` | `Action::"<T>"` |
| `resource` | `Tool::"<T>"` |
| `context.args` | the call's arguments, exactly as the agent sent them. **Provenance: claimed.** |
| `context.facts` | results of the gateway's own upstream lookups configured in `facts`. **Provenance: observed.** |
| `context.grant` | `{ principal, scopes }` from the signed delegation. **Provenance: attested.** |

No entity hierarchy or schema is loaded yet, so policies reason about `context` and the three identifiers above.

Two things happen before Cedar runs and cannot be overridden by policy:

1. If `T` is not in the grant's scopes, the call is denied. No facts are fetched.
2. Each configured fact for `T` is fetched from upstream. If any lookup fails, the call is denied.

## The rules Cedar applies

- **Default deny.** With no matching `permit`, the decision is deny.
- **`forbid` wins.** A matching `forbid` overrides every `permit`.
- **Errors deny.** If evaluating any policy raises an error, such as a missing attribute or a float, the gateway denies regardless of what other policies said. The errors are recorded in the receipt.
- **The policy is pinned.** The receipt carries the sha256 of the policy file, so a verifier knows which text produced the decision.

## Examples

Each of these is a complete, valid policy file.

**Permit a read to any agent holding the scope.**

```cedar
permit(principal, action == Action::"customer.lookup", resource);
```

**Cap an amount.** Amounts are integer minor units. 100000 pence is £1,000.

```cedar
permit(principal, action == Action::"stripe.refund", resource)
when { context.args.amount <= 100000 };
```

A call without `amount` is an error, hence a deny. That is the behaviour you want from a payments policy.

**Require a fact the gateway fetched, not something the agent asserted.** This is the pattern the whole project exists for.

```cedar
permit(principal, action == Action::"stripe.refund", resource)
when {
  context.args.amount <= 100000 &&
  context.facts has customer &&
  context.facts.customer.verified == true
};
```

With the matching `facts` entry in the gateway config, `context.facts.customer` is whatever `customer.lookup` returned for the customer id in the call. An agent that sends `{ "verified": true }` in its arguments changes nothing, because the policy never reads `context.args.verified`.

**Restrict to a named agent.**

```cedar
permit(principal == Agent::"support-agent", action == Action::"stripe.refund", resource);
```

**Several tools in one rule.**

```cedar
permit(principal, action in [Action::"customer.lookup", Action::"customer.search"], resource);
```

**A hard block that no permit can override.**

```cedar
permit(principal, action == Action::"stripe.refund", resource)
when { context.args.amount <= 100000 };

forbid(principal, action == Action::"stripe.refund", resource)
when { context.facts has customer && context.facts.customer.flagged == true };
```

**Pattern-match a string argument.**

```cedar
permit(principal, action == Action::"github.merge", resource)
when { context.args.repo like "acme/*" && context.args.base == "main" };
```

**`unless` reads better for exceptions.**

```cedar
permit(principal, action == Action::"stripe.refund", resource)
unless { context.args.currency != "GBP" };
```

**Reach the grant itself.**

```cedar
permit(principal, action, resource)
when { context.grant.principal == "user_456" };
```

## Gotchas

- **Integers only.** `12.50` is not a Cedar value. Send `1250`.
- **Test `has` before reading an optional attribute.** `context.facts.customer.verified` errors if there is no `customer` fact, and an error is a deny. Sometimes that is what you want. When it is not, guard with `context.facts has customer`.
- **No schema means no typo protection.** A policy that reads `context.args.ammount` never matches and every refund is denied. Fail-closed hides typos as denials, so test your policies.
- **Scope is enforced outside Cedar.** You cannot use a policy to grant a tool the delegation did not include.

## Testing a policy

The evaluator is a pure function, so a policy test is a unit test. See [test/policy.test.ts](../test/policy.test.ts).

```ts
import { evaluate } from "../src/policy.ts";
import { readFileSync } from "node:fs";

const policy = readFileSync("policy.cedar", "utf8");
const d = evaluate(policy, {
  agentId: "support-agent",
  tool: "stripe.refund",
  context: {
    args: { customer_id: "cust_123", amount: 50000 },
    facts: { customer: { verified: true } },
    grant: { principal: "user_456", scopes: ["customer.lookup", "stripe.refund"] },
  },
});
// d.decision  "allow" | "deny"
// d.reasons   ids of the policies that decided it
// d.errors    evaluation errors, non-empty always means deny
// d.policyDigest  sha256 of the policy text, the same value a receipt will carry
```

Write one case per branch of every `when` clause, plus one for the missing-attribute path.

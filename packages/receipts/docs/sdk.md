# The interceptor SDK

The gateway sees only MCP traffic. The SDK sees whatever the agent framework lets it hook, from inside the agent's own process. It issues the same receipt format, verified by the same command, with one difference a verifier cannot miss: the receipt names its issuer as `sdk`, and every field is `claimed`.

| | gateway | SDK |
| --- | --- | --- |
| runs | as a separate process between agent and tools | inside the agent's process |
| sees | MCP tool calls only | whatever the framework's hooks expose |
| can enforce | yes, the call never reaches upstream on deny | only where the hook can block, and only if nobody bypasses the hook |
| facts | fetched by the gateway itself, `observed` | none; policies see `context.args` only |
| delegation | required, signed by the principal | none; principal is a config string, `claimed` |
| a verifier learns | the agent could not have skipped or forged this | the agent's process reported this, and it has not changed since |
| install | change one line in the host's MCP config | add a hook or wrap a tool function |

Use the SDK for reach. Use the gateway for anything that moves money, touches production, or handles personal data. Both write to the same receipt directory and log if you point them there.

## Configuration

```json
{
  "agentId": "billing-bot",
  "principalId": "user_456",
  "identity": { "keyFile": "keys/app.key" },
  "policyFile": "policy.cedar",
  "receiptsDir": "receipts",
  "logFile": "log.jsonl",
  "framework": "claude-code"
}
```

`policyFile` and `principalId` are optional. Without a policy the SDK records and never denies. Paths resolve relative to the config file. Instead of `logFile`, `"log": { "url": "https://log.example.com/", "tokenEnv": "AGENT_CUSTODY_LOG_TOKEN" }` sends every leaf to a log run by someone else, whose key then signs the tree heads; see [usage.md](usage.md) for what that changes and [verification.md](verification.md) for what it proves. Generate the key with `node src/cli.ts keygen --dir keys --name app`.

Policies see `context.args` and an empty `context.facts`. A policy that reads `context.facts` or `context.grant` errors, which is a deny. That is intended: an SDK policy cannot pretend it checked something outside the agent's process.

## Claude Code

Register the hook command in `.claude/settings.json`. The same command handles all three events.

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "mcp__.*|Bash|Write|Edit", "hooks": [{ "type": "command", "command": "node /abs/path/agent-custody/packages/receipts/src/cli.ts hook --config /abs/path/sdk.json" }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "node /abs/path/agent-custody/packages/receipts/src/cli.ts hook --config /abs/path/sdk.json" }] }
    ],
    "PostToolUseFailure": [
      { "hooks": [{ "type": "command", "command": "node /abs/path/agent-custody/packages/receipts/src/cli.ts hook --config /abs/path/sdk.json" }] }
    ]
  }
}
```

`AGENT_CUSTODY_CONFIG` works instead of `--config`. Behaviour per event:

- **PreToolUse.** Evaluates the policy. On deny, issues a denial receipt and returns `permissionDecision: "deny"` with the receipt id in the reason. On allow, or with no policy, returns no decision, so Claude Code's own permission prompts still apply. The hook never auto-approves.
- **PostToolUse.** Issues an executed receipt carrying `tool_response`.
- **PostToolUseFailure.** Issues a failed receipt.

Session and tool-use ids from the event are recorded so a receipt can be matched to the transcript. If the user declines a call at the permission prompt, no PostToolUse fires and no receipt is issued for it. Claude Code records that in its own transcript, not here.

## Claude Agent SDK, in-process

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadSdkConfig } from "@agent-custody/receipts";
import { claudeAgentHooks, createSdkIssuer } from "@agent-custody/receipts/sdk/claude";

const issuer = createSdkIssuer(loadSdkConfig("./sdk.json"));

for await (const msg of query({
  prompt: "Refund the customer",
  options: { hooks: claudeAgentHooks(issuer) },
})) {
  // ...
}
```

`claudeAgentHooks(issuer, matcher?)` returns entries for `PreToolUse`, `PostToolUse`, and `PostToolUseFailure` with the same behaviour as the command hook. The hook callback receives the same JSON fields, so the handler is shared. This adapter is typed loosely and does not import the SDK package; it has been exercised against the documented hook contract, not against a live `query()` run.

## OpenAI Agents SDK (JS)

Two adapters in [src/sdk/openai-agents.ts](../src/sdk/openai-agents.ts). Both are tested against the real package with a scripted model and a real `Runner`, no network.

```ts
import { Agent, Runner } from "@openai/agents";
import { wrapTools, observeRunner } from "@agent-custody/receipts/sdk/openai-agents";

// enforcement + receipts: wrap the tools you hand to the agent
const agent = new Agent({ name: "billing", tools: wrapTools(issuer, [refundTool, lookupTool]) });

// receipts only: attach to the runner's lifecycle events, nothing to wrap, no policy evaluated
const runner = new Runner();
observeRunner(issuer, runner);
```

`wrapTools` wraps each tool's `invoke`. On a policy deny the tool never runs; the model receives the denial text as the tool result, with the receipt id, and the run continues. That matches what a model sees when a human declines a tool. `observeRunner` listens to `agent_tool_start` and `agent_tool_end`, pairs them by call id, and records executed receipts with no policy. Use one or the other for a given tool, not both.

## Vercel AI SDK

[src/sdk/vercel-ai.ts](../src/sdk/vercel-ai.ts), tested with a real `generateText` loop over a mock model.

```ts
import { generateText } from "ai";
import { wrapTools } from "@agent-custody/receipts/sdk/vercel-ai";

const result = await generateText({ model, prompt, tools: wrapTools(issuer, tools) });
```

`wrapTools` returns a new tool set with every `execute` wrapped. Tools without `execute` pass through untouched. On deny it throws `PolicyDeniedError`, which the AI SDK turns into a `tool-error` part that the model sees; the loop continues. The receipt records the `toolCallId`.

## LangChain / LangGraph (JS)

[src/sdk/langchain.ts](../src/sdk/langchain.ts), tested against real `StructuredTool` invocations.

```ts
import { tool } from "@langchain/core/tools";
import { receiptCallbacks, ReceiptCallbackHandler } from "@agent-custody/receipts/sdk/langchain";

// receipts only: a callback handler, attach per call or on the whole graph
await refund.invoke({ customer_id, amount }, receiptCallbacks(issuer));
const graph = workflow.compile().withConfig({ callbacks: [new ReceiptCallbackHandler(issuer)] });

// enforcement: build the tool from issuer.wrap()
const refund = tool(issuer.wrap("stripe.refund", fn), { name: "stripe.refund", schema });
```

LangChain callbacks cannot block a tool, so the handler evaluates no policy; it records what happened, including the `tool_call_id` when one is present, and unwraps `ToolMessage` outputs. For enforcement wrap the function at construction. Do not do both on one tool or it will be recorded twice.

## Any other framework: wrap the function

Every agent framework ends up calling a function. Wrap it.

```ts
import { loadSdkConfig } from "@agent-custody/receipts";
import { createSdkIssuer, PolicyDeniedError } from "@agent-custody/receipts";

const issuer = createSdkIssuer(loadSdkConfig("./sdk.json"));

const refund = issuer.wrap("stripe.refund", async (args: { customer_id: string; amount: number }) => {
  return stripe.refunds.create({ customer: args.customer_id, amount: args.amount });
});

try {
  await refund({ customer_id: "cust_123", amount: 50000 });   // executed receipt
} catch (e) {
  if (e instanceof PolicyDeniedError) console.log(e.receiptId); // denial receipt, tool never ran
  throw e;                                                       // any other error: error receipt, rethrown
}
```

For finer control use the two primitives `wrap` is built from:

```ts
const decision = issuer.decide({ tool, args });                       // PolicyDecision | null
const bundle = await issuer.record({ tool, args, model, session }, { status: "executed", result }, decision);
```

`record` returns a promise because the log may be remote. It rejects, and writes no bundle, if the log refuses the leaf. `handleHookEvent` is asynchronous for the same reason. The record-only adapters that cannot await, such as `observeRunner`, report a refused leaf on stderr.

## Which adapter enforces

| framework | enforce + record | record only |
| --- | --- | --- |
| Claude Code | `hook` command, PreToolUse deny | PostToolUse |
| Claude Agent SDK | `claudeAgentHooks` | same |
| OpenAI Agents SDK | `wrapTools` | `observeRunner` |
| Vercel AI SDK | `wrapTools` | wrap with a policy-less issuer |
| LangChain / LangGraph | `tool(issuer.wrap(...))` | `ReceiptCallbackHandler` |
| anything else | `issuer.wrap` | `issuer.record` |

Record-only adapters evaluate no policy on purpose. A receipt that said "policy: deny" next to "execution: executed" would fail verification, and the verifier would be right: that is not a receipt, that is a finding. Enforce, or observe, but do not pretend.

The three framework packages are optional peer dependencies. Each adapter imports only from its own package, so installing none of them costs nothing.

## What an SDK receipt is worth

A verified SDK receipt establishes that a process holding the application key reported this call, at this time, with these arguments and this result, and that the record has not changed since. It does not establish that the process reported every call, that the arguments are what the tool really received, or that anyone outside the process checked anything. The verifier prints exactly that sentence under `ISSUER`. Keep it in the dashboard too.

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

`policyFile` and `principalId` are optional. Without a policy the SDK records and never denies. Paths resolve relative to the config file. Generate the key with `node src/cli.ts keygen --dir keys --name app`.

Policies see `context.args` and an empty `context.facts`. A policy that reads `context.facts` or `context.grant` errors, which is a deny. That is intended: an SDK policy cannot pretend it checked something outside the agent's process.

## Claude Code

Register the hook command in `.claude/settings.json`. The same command handles all three events.

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "mcp__.*|Bash|Write|Edit", "hooks": [{ "type": "command", "command": "node /abs/path/agent-receipts/src/cli.ts hook --config /abs/path/sdk.json" }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "node /abs/path/agent-receipts/src/cli.ts hook --config /abs/path/sdk.json" }] }
    ],
    "PostToolUseFailure": [
      { "hooks": [{ "type": "command", "command": "node /abs/path/agent-receipts/src/cli.ts hook --config /abs/path/sdk.json" }] }
    ]
  }
}
```

`AGENT_RECEIPTS_CONFIG` works instead of `--config`. Behaviour per event:

- **PreToolUse.** Evaluates the policy. On deny, issues a denial receipt and returns `permissionDecision: "deny"` with the receipt id in the reason. On allow, or with no policy, returns no decision, so Claude Code's own permission prompts still apply. The hook never auto-approves.
- **PostToolUse.** Issues an executed receipt carrying `tool_response`.
- **PostToolUseFailure.** Issues a failed receipt.

Session and tool-use ids from the event are recorded so a receipt can be matched to the transcript. If the user declines a call at the permission prompt, no PostToolUse fires and no receipt is issued for it. Claude Code records that in its own transcript, not here.

## Claude Agent SDK, in-process

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadSdkConfig } from "agent-receipts/src/config.ts";
import { claudeAgentHooks, createSdkIssuer } from "agent-receipts/src/sdk/claude.ts";

const issuer = createSdkIssuer(loadSdkConfig("./sdk.json"));

for await (const msg of query({
  prompt: "Refund the customer",
  options: { hooks: claudeAgentHooks(issuer) },
})) {
  // ...
}
```

`claudeAgentHooks(issuer, matcher?)` returns entries for `PreToolUse`, `PostToolUse`, and `PostToolUseFailure` with the same behaviour as the command hook. The hook callback receives the same JSON fields, so the handler is shared. This adapter is typed loosely and does not import the SDK package; it has been exercised against the documented hook contract, not against a live `query()` run.

## Any framework: wrap the tool function

Every agent framework ends up calling a function. Wrap it.

```ts
import { loadSdkConfig } from "agent-receipts/src/config.ts";
import { createSdkIssuer, PolicyDeniedError } from "agent-receipts/src/sdk/index.ts";

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

`wrap` decides, runs, and records. It works wherever a tool is a function you construct:

- **OpenAI Agents SDK (JS):** `tool({ name, parameters, execute: issuer.wrap("name", execute) })`.
- **Vercel AI SDK:** `tool({ description, parameters, execute: issuer.wrap("name", execute) })`.
- **LangChain / LangGraph (JS):** `tool(issuer.wrap("name", fn), { name, schema })`.

These three lines describe how the wrapper composes with each package's API. The wrapper itself is tested; the composition with those packages is not yet, and they are not dependencies of this project. Framework-specific adapters that hook `on_tool_start` / `on_tool_end` callbacks, so nothing needs wrapping, are the next step on the roadmap.

For finer control use the two primitives `wrap` is built from:

```ts
const decision = issuer.decide({ tool, args });                       // PolicyDecision | null
const bundle = issuer.record({ tool, args, model, session }, { status: "executed", result }, decision);
```

## What an SDK receipt is worth

A verified SDK receipt establishes that a process holding the application key reported this call, at this time, with these arguments and this result, and that the record has not changed since. It does not establish that the process reported every call, that the arguments are what the tool really received, or that anyone outside the process checked anything. The verifier prints exactly that sentence under `ISSUER`. Keep it in the dashboard too.

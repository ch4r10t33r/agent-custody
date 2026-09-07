# Usage guide: the gateway

This page covers the gateway, the out-of-process producer. For the in-process interceptor that hooks Claude Code, the Claude Agent SDK, or any framework's tool functions, see [sdk.md](sdk.md).

## The parts

| part | what it is | who controls it |
| --- | --- | --- |
| principal | the human or organisation on whose authority the agent acts | you |
| agent | any MCP client: Claude Desktop, Claude Code, a LangGraph node, your own loop | you, but its behaviour is not trusted |
| gateway | this project, run as an MCP server over stdio | you, holds the gateway signing key |
| upstream | the real MCP server the agent wants: Stripe, a database, GitHub | the tool provider |
| grant | a signed statement: principal P lets agent A use tools [..] from T1 to T2 | signed by the principal's key |
| policy | a Cedar file evaluated on every call | you |
| receipt bundle | one JSON file per call, signed, with a log inclusion proof | produced by the gateway |
| log | an append-only JSONL file whose Merkle root every receipt commits to | produced by the gateway |

One gateway process serves one delegation grant. That maps cleanly onto "one agent session, spawned per user, with a scoped grant". Run several gateways for several agents.

## Setup, step by step

All commands run from `packages/receipts`. `node src/cli.ts` works on Node 22 and later without a build step.

**1. Generate keys.** One pair for the gateway, one for the principal. Keep the `.key` files private; distribute the `.pub` files to anyone who will verify receipts.

```bash
node src/cli.ts keygen --dir ./keys --name gateway
node src/cli.ts keygen --dir ./keys --name principal
```

**2. Issue a grant.** The principal signs which agent may use which tools, and for how long.

```bash
node src/cli.ts grant \
  --key ./keys/principal.key \
  --principal user_456 \
  --agent support-agent \
  --scopes customer.lookup,stripe.refund \
  --ttl-hours 8 \
  --out ./grant.json
```

The gateway refuses to start if the grant is outside its validity window, and every receipt records the grant so a verifier can re-check it.

**3. Write a policy.** A Cedar file. Default is deny. See [policies.md](policies.md).

```cedar
permit(principal, action == Action::"customer.lookup", resource);

permit(principal, action == Action::"stripe.refund", resource)
when {
  context.args.amount <= 100000 &&
  context.facts has customer &&
  context.facts.customer.verified == true
};
```

**4. Write the gateway config.** Paths resolve relative to the config file.

```json
{
  "identity": { "keyFile": "keys/gateway.key" },
  "upstream": { "command": "node", "args": ["/path/to/stripe-mcp-server.js"], "env": { "STRIPE_KEY": "sk_..." } },
  "grantFile": "grant.json",
  "trustedPrincipalKeys": ["keys/principal.pub"],
  "policyFile": "policy.cedar",
  "facts": [
    {
      "name": "customer",
      "tool": "customer.lookup",
      "args": { "customer_id": "$args.customer_id" },
      "forTools": ["stripe.refund"]
    }
  ],
  "receiptsDir": "receipts",
  "logFile": "log.jsonl"
}
```

`upstream` is spawned by the gateway exactly as an MCP host would spawn it. `env` is passed through, which is where upstream credentials go. The agent never sees them. An upstream that is already running is reached instead with `"upstream": { "url": "https://memory.internal/mcp", "tokenEnv": "MEMORY_TOKEN" }`, over Streamable HTTP with a bearer token from the environment; the shared memory server in `@agent-custody/state` is the usual case.

`logFile` is the local Merkle log, with tree heads signed by the gateway's own key. To log to a server the operator does not control, replace it with `log`:

```json
  "log": { "url": "https://log.example.com/", "tokenEnv": "AGENT_CUSTODY_LOG_TOKEN" }
```

Exactly one of the two. The bearer token comes from the named environment variable, never from the file, and a missing variable fails at startup. With a remote log the tree head in each receipt is signed by the log's key, and a verifier must be given that key with `--log-key`. If the log refuses a leaf, the receipt is not issued and the call returns an error to the agent; for an executed call the upstream action has already happened by then, which is the honest outcome, since a receipt that was never logged must not be handed out. The reference log server is `node src/cli.ts log --file log.jsonl --key keys/log.key --port 8787 --token-env AGENT_CUSTODY_LOG_TOKEN`. It serves `POST /append` (token required when one is configured), `GET /root?size=N`, `GET /consistency?old=M&new=N`, and `GET /head`; [verification.md](verification.md) says what each proves.

`facts` tells the gateway which upstream tool to call before evaluating policy for a given tool. `$args.<key>` copies a value from the intercepted call. The result appears in Cedar as `context.facts.<name>` and in the receipt with its own digest, labelled `observed`. If a fact lookup fails, the call is denied and the receipt says why. A lookup with `"optional": true` is skipped when a `$args.<key>` it needs is absent from the call, and the fact is then simply not present, which a policy tests with `context.facts has <name>`; this is how a policy sees the fact a `memory.write` is about to supersede without denying every write that supersedes nothing.

**5. Run the gateway.** It speaks MCP on stdin/stdout and logs to stderr only.

```bash
node src/cli.ts gateway --config ./gateway.json
```

You will not normally run this by hand. The agent host spawns it, as below.

## Wiring it into an agent host

The gateway is an ordinary MCP server, so any host that can launch a stdio MCP server can use it. Point the host at the gateway instead of at the upstream server.

### Claude Desktop

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "stripe": {
      "command": "node",
      "args": ["/abs/path/agent-custody/packages/receipts/src/cli.ts", "gateway", "--config", "/abs/path/gateway.json"]
    }
  }
}
```

Claude sees only the tools inside the grant's scopes. Every call it makes produces a receipt. Denials come back as tool errors with the receipt id in the text.

### Claude Code

```bash
claude mcp add stripe -- node /abs/path/agent-custody/packages/receipts/src/cli.ts gateway --config /abs/path/gateway.json
```

### Python hosts

The gateway is language-neutral: any host that can launch a stdio MCP server can use it. Claude Agent SDK for Python:

```python
from claude_agent_sdk import ClaudeAgentOptions, query

options = ClaudeAgentOptions(mcp_servers={"stripe": {"command": "node", "args": ["/abs/path/agent-custody/packages/receipts/src/cli.ts", "gateway", "--config", "/abs/path/gateway.json"]}})
async for message in query(prompt="Refund customer cust_123 by 50 dollars", options=options):
    ...
```

OpenAI Agents SDK for Python:

```python
from agents import Agent, Runner
from agents.mcp import MCPServerStdio

async with MCPServerStdio(params={"command": "node", "args": ["/abs/path/agent-custody/packages/receipts/src/cli.ts", "gateway", "--config", "/abs/path/gateway.json"]}) as stripe:
    agent = Agent(name="support", instructions="...", mcp_servers=[stripe])
    result = await Runner.run(agent, "Refund customer cust_123 by 50 dollars")
```

With the npm package installed globally, `"command": "agent-custody", "args": ["gateway", "--config", ...]` replaces the node invocation. Every tool the agent sees comes through the gateway; denied calls never reach Stripe and still produce a receipt. For receipts from tools that are plain Python functions rather than MCP servers, use the sidecar and the Python package, in [sdk.md](sdk.md).

### Your own agent loop (TypeScript)

This is what [scripts/demo.ts](../scripts/demo.ts) does.

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const agent = new Client({ name: "my-agent", version: "1.0.0" });
await agent.connect(new StdioClientTransport({
  command: "node",
  args: ["/abs/path/agent-custody/packages/receipts/src/cli.ts", "gateway", "--config", "/abs/path/gateway.json"],
}));

const { tools } = await agent.listTools();               // only tools in the grant's scopes

const result = await agent.callTool({
  name: "stripe.refund",
  arguments: { customer_id: "cust_123", amount: 50000 },
  _meta: { "agent-custody/model": "claude-fable-5-1" },  // optional, recorded as "claimed"
});

const receiptId = result._meta?.["agent-custody/receipt"];
if (result.isError) {
  // denied by scope or policy, or upstream failed; the text says which, and a receipt exists either way
}
```

Any other MCP client works the same way: Python's `mcp` package, LangGraph's MCP adapters, or the OpenAI Agents SDK MCP support. None of them need to know the gateway is there.

## What the agent gets back

| outcome | `isError` | content | receipt |
| --- | --- | --- | --- |
| executed | as returned by upstream | upstream's content, untouched | `_meta["agent-custody/receipt"]` |
| upstream returned an error | `true` | upstream's content | same |
| denied by scope or policy | `true` | `Denied by policy: <reason> (receipt <id>)` | same |
| upstream unreachable | `true` | `Upstream error: <message> (receipt <id>)` | same |

The receipt id is the file name under `receiptsDir`.

## What the upstream gets

The call the gateway forwards carries three `_meta` keys the agent cannot set: `agent-custody/receipt`, the id of the receipt being issued for this call; `agent-custody/agent` and `agent-custody/principal`, from the signed delegation grant. An upstream that keeps state can cite the receipt as the source of what it stores and record the attested caller rather than a claimed one. The memory server in `@agent-custody/state` does exactly that. Fact lookups carry the same keys, since they are the gateway acting for the same receipt.

The upstream can answer in kind. A result whose `_meta` carries `agent-custody/facts`, an array of fact ids, tells the gateway which facts it just served; the gateway remembers them for the rest of the session and every later receipt carries them as `consumed`, labelled `observed` because the gateway saw those results itself. That is what the agent had been shown by the time of each call, an upper bound on what it relied on, and it is what the state package's blast-radius query walks.

## Operational notes

- **Money is integer minor units.** Cedar has no floating point. A float in `args` that a policy touches is an evaluation error, which is a deny.
- **The gateway key is the trust root for receipts.** Keep it out of the agent's reach. The upstream credentials in `upstream.env` are likewise never exposed to the agent.
- **Rotate keys by adding, not replacing.** The verifier accepts a list of gateway keys and principal keys and matches by keyid, so old receipts stay verifiable.
- **The log is append-only by convention, not enforcement.** Copy it somewhere the operator cannot rewrite, on a schedule. The receipts' tree heads let an auditor check that the copy matches.
- **stdout is the MCP channel.** Anything the gateway prints goes to stderr. Do not add `console.log` to gateway code paths.

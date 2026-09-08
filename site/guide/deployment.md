# Deployment

Nobody's agent calls agent-custody. The agent never learns it exists. There are three places the layer can sit, and a deployment uses whichever of them the job needs.

```
agent host  (Claude Code, LangGraph, the OpenAI Agents SDK, your own loop)
   │  MCP, unchanged: the host is pointed at the gateway instead of at the tool
   ▼
agent-custody gateway          → one signed receipt per call → the local log, or a log run by someone else
   │  MCP, unchanged
   ▼
the tool servers the agent already used: Stripe, GitHub, the memory server, several at once under one grant
```

## The gateway: outside the agent, in front of the tools

The gateway is an MCP server because MCP is what the host already speaks to its tools. It is a transparent proxy in that protocol, the way an API gateway sits in front of an HTTP service. The only change on the agent's side is one line of host config: where it named the Stripe MCP server, it now names the gateway, and the gateway forwards. The agent still believes it is talking to Stripe.

Being outside the agent's process is what lets the gateway do two things a log collector cannot: refuse a call before the tool runs, and sign the record with a key the agent never holds. One gateway runs per agent session, on stdio, as MCP hosts run their servers; it fronts several upstreams under one human-signed grant. [Setting it up](/receipts/usage).

## The SDK: inside the agent, for tools that are not MCP servers

For tools that are plain functions, the SDK hooks the framework the agent already uses: a Claude Code hook, a LangChain callback, a wrapped OpenAI Agents or Vercel AI tool. No new server, no change to the tool. The record is self-reported, since it comes from inside the process it describes, and every receipt says so with the `claimed` label. Agents in other languages get the same through the sidecar, a local HTTP process holding the key, with a Python package and Go, Java, and Rust clients. [The interceptor SDK](/receipts/sdk).

## The memory server: the belief ledger, behind the gateway

The memory server is not for logging. It is the belief ledger's interface, exposed as MCP tools because that is how agents use memory, and it runs as one of the gateway's upstreams so that every write and read inherits the policy check and the receipt. Over stdio it serves one gateway; over HTTP with a bearer token it is one shared ledger for many gateways and, if allowed, direct writers, which is when quarantine does its work. Teams that only want receipts for actions never run it. [The memory server](/state/#the-memory-server).

## What the gateway does not cover

Everything the gateway proves holds for calls that go through it. These do not, and no receipt says otherwise:

- **An API key in the agent's environment.** If the agent process holds a Stripe key, it can call Stripe directly and nothing here sees it. The fix is a deployment decision: the key lives in the gateway's environment (`upstream.env`, or `headerEnv` on a REST upstream) and not in the agent's.
- **Another MCP server in the host config.** A host that names the gateway and also names the tool server directly gives the agent both routes. Remove the direct one.
- **SDK-only wraps and the sidecar.** They run inside the agent's process and record what that process tells them. Every such receipt is `claimed`, and the report says so on the `ISSUER` line.
- **Subprocesses, databases, queues, and other agents** reached without MCP or the REST connector. Same as the first point: if the agent holds the credential, the agent decides.

## Where interception stops

If agent code calls an HTTP API directly, outside MCP and outside a wrapped function, nothing here sees it. The answer built for that is the REST connector: describe the API's endpoints as tools in the gateway config, with the credential read from the environment, and the agent calls them through the gateway instead of holding the API key itself. Scope, policy on the gateway's own lookups, pre-commit, and receipts then apply to REST calls exactly as to MCP calls, and a REST upstream sits beside MCP upstreams behind one grant. What remains outside is code that keeps its own credentials and calls out on its own; taking those away from the agent is a deployment decision, not a feature. A transparent egress proxy that intercepts arbitrary HTTP is not built and not planned until a design partner needs it.

## Observability you already have

Receipts are not a dashboard. With `otel` in a gateway or SDK config, each receipt is also exported as one span to the OTLP collector the team already runs, Datadog, Grafana, Splunk, or whatever sits behind it, with the receipt id as the trace id. Nothing is replaced: the traces the agent framework already emits stay as they are, and the receipt span sits beside them, pointing at the evidence. The export runs after the receipt and never blocks or fails it.

## What you are trusting, by setup

- **SDK or sidecar only.** The record is self-reported by the agent's own process; every field is `claimed`. Good for a history, not for a dispute.
- **Gateway with the default local log.** Decisions and outcomes were observed outside the agent, and the log is tamper-evident to anyone holding a copy. The operator holds the gateway key and the log file, and can rewrite their own history; a copy taken out of their control is what detects it.
- **Gateway with a log run by someone else.** The tree heads are signed by a key the operator does not hold. This is the setup in which the operator is not trusted, and it is the one to use when a receipt has an audience outside the team. The reference log server ships in the package, and one is [running](/early-access).
- **The same, with a witness.** A second signer on a machine the log's operator does not control countersigns the log's checkpoints after proving each extends the last. A verifier who requires the witness is protected against the log's operator too. The witness ships in the package; running one for our log is the next step.

## Sizing

One gateway process per agent session is far more than one session needs; the gateway's overhead per call is small next to the tool calls it forwards, and the Merkle log's append cost does not grow with the log. The shared pieces, the remote log server and the HTTP memory server, are single processes. Indexed queries for large ledgers are in place for SQLite and Postgres. The receipts package README records the measurements and the script that produced them, for anyone sizing a deployment.

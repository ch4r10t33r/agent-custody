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

Being outside the agent's process is what lets the gateway do two things a log collector cannot: refuse a call before the tool runs, and sign the record with a key the agent never holds. One gateway runs per agent session, on stdio, as MCP hosts run their servers; it fronts several upstreams under one human-signed grant. Its own overhead is about half a millisecond per call. [Setting it up](/receipts/usage).

## The SDK: inside the agent, for tools that are not MCP servers

For tools that are plain functions, the SDK hooks the framework the agent already uses: a Claude Code hook, a LangChain callback, a wrapped OpenAI Agents or Vercel AI tool. No new server, no change to the tool. The record is self-reported, since it comes from inside the process it describes, and every receipt says so with the `claimed` label. Agents in other languages get the same through the sidecar, a local HTTP process holding the key, with a Python package and Go, Java, and Rust clients. [The interceptor SDK](/receipts/sdk).

## The memory server: the belief ledger, behind the gateway

The memory server is not for logging. It is the belief ledger's interface, exposed as MCP tools because that is how agents use memory, and it runs as one of the gateway's upstreams so that every write and read inherits the policy check and the receipt. Over stdio it serves one gateway; over HTTP with a bearer token it is one shared ledger for many gateways and, if allowed, direct writers, which is when quarantine does its work. Teams that only want receipts for actions never run it. [The memory server](/state/#the-memory-server).

## Where interception stops

If agent code calls an HTTP API directly, outside MCP and outside a wrapped function, nothing here sees it. The general answer is an egress proxy that issues receipts for arbitrary HTTP calls, the same design as the gateway one protocol lower. It is not built and not on the roadmap until a design partner's agents mostly call REST APIs directly.

## Sizing

Measured on a laptop, one process: 0.15 ms per receipt through the SDK regardless of log size, about half a millisecond per gateway call including policy, a fact lookup, and an upstream signature, and roughly two thousand calls a second per gateway process, two orders of magnitude more than one agent session produces. The shared pieces, the remote log server and the HTTP memory server, are single processes; a tenanted hosted log is the [early-access](/early-access) offer, and indexed queries for very large ledgers are tracked in the state package's plan.

# agent-receipts

Signed, independently verifiable receipts for AI agent tool calls.

Two producers, one receipt format, one verifier.

- **The gateway** is an MCP proxy between an agent and the systems it can affect. For every tool call, allowed or denied, it checks a delegation grant signed by the human principal, gathers the facts the policy needs by calling upstream itself, evaluates a Cedar policy that fails closed, forwards the call only on allow, and emits a signed receipt appended to a Merkle transparency log.
- **The SDK** is an interceptor inside the agent's own process, hooked into the framework's tool-call callbacks: Claude Code, the Claude Agent SDK, the OpenAI Agents SDK, the Vercel AI SDK, LangChain, or any function you wrap. It reaches everything the gateway cannot see and issues the same receipts, labelled as self-reported.

Anyone holding the public keys can verify a receipt offline. The agent is not trusted. The layer around it is, and the receipt says exactly how far that trust extends, starting with who issued it.

- [Usage guide](docs/usage.md): gateway setup, wiring into Claude Desktop, Claude Code, or your own agent loop
- [The interceptor SDK](docs/sdk.md): Claude Code hooks, the Claude Agent SDK, adapters for the OpenAI Agents SDK, Vercel AI SDK and LangChain, and wrapping tool functions in anything else
- [Writing policies](docs/policies.md): how a tool call becomes a Cedar request, with tested examples
- [Verifying a receipt](docs/verification.md): what each check means and what a verified receipt does and does not prove

## How it fits together

```mermaid
flowchart LR
    P["Principal<br/>(human or org, holds a signing key)"]
    A["Agent host<br/>Claude Desktop, Claude Code,<br/>LangGraph, custom loop"]
    S["SDK interceptor<br/>inside the agent process:<br/>hooks or wrapped tools"]
    G["agent-receipts gateway<br/>scope check → fact lookups → Cedar policy"]
    U["Upstream MCP server<br/>Stripe, database, GitHub, ..."]
    R[("receipt bundles<br/>receipts/*.json")]
    L[("Merkle log<br/>log.jsonl")]
    V["Verifier<br/>auditor, counterparty, CI job"]
    O["Observability<br/>OTel, LangSmith, Arize"]

    P -- "signed delegation grant" --> G
    A -- "MCP tools/call" --> G
    G -- "only on allow" --> U
    U -- "result" --> G
    G -- "result + receipt id, or denial + receipt id" --> A
    G -- "signed receipt (issuer: gateway)" --> R
    G -- "leaf hash" --> L
    A -. "in-process tool calls" .-> S
    S -- "signed receipt (issuer: sdk)" --> R
    S -- "leaf hash" --> L
    R --> V
    L -. "copy of the log (optional)" .-> V
    P -. "public key" .-> V
    G -. "public key" .-> V
    A -. "traces (unchanged)" .-> O
```

Three parties hold keys. The **principal** signs a grant saying which agent may use which tools until when. The **issuer**, gateway or SDK, signs every receipt and every tree head. The **verifier** holds only public keys and needs no access to the issuer, the agent, or the upstream system.

## Two producers, one receipt

| | gateway | SDK |
| --- | --- | --- |
| where it runs | separate process between agent and tools | inside the agent's process |
| what it sees | MCP tool calls | whatever the framework's hooks expose |
| enforcement | yes, denied calls never reach upstream | only where a hook can block |
| provenance of its fields | `attested` and `observed` | `claimed`, all of them |
| what a verifier learns | the agent could not skip or forge this | the agent's process reported this and it has not changed since |
| install | one line in the host's MCP config | a hook entry or a wrapped function |

Every receipt names its issuer, and the verifier prints what that issuer kind is worth before anything else. A dashboard full of `sdk` rows is the reason to route the consequential calls through the gateway.

### Supported hosts and frameworks

| host or framework | producer | enforce + record | record only | tested against |
| --- | --- | --- | --- | --- |
| any MCP host: Claude Desktop, Claude Code, Cursor, custom | gateway | yes | | a real MCP client and upstream over stdio |
| Claude Code | SDK | `hook` command, PreToolUse deny | PostToolUse | the documented hook contract, via stdin |
| Claude Agent SDK | SDK | `claudeAgentHooks` | same | the same handler |
| OpenAI Agents SDK (JS) | SDK | `wrapTools` | `observeRunner` | a real `Runner` with a scripted model |
| Vercel AI SDK | SDK | `wrapTools` | | a real `generateText` loop over the SDK's mock model |
| LangChain / LangGraph (JS) | SDK | `tool(issuer.wrap(fn))` | `ReceiptCallbackHandler` | real `StructuredTool` invocations |
| anything else | SDK | `issuer.wrap(name, fn)` | `issuer.record` | plain functions |

The framework packages are optional peer dependencies. Each adapter imports only from its own package.

## One tool call, end to end

```mermaid
sequenceDiagram
    participant Agent
    participant Gateway
    participant Upstream as Upstream MCP server
    participant Log as Merkle log

    Agent->>Gateway: tools/call stripe.refund {customer_id, amount}
    Gateway->>Gateway: tool in signed grant's scopes?
    Gateway->>Upstream: tools/call customer.lookup {customer_id}
    Upstream-->>Gateway: {verified: true}
    Note over Gateway: facts.customer = that result, labelled "observed"
    Gateway->>Gateway: Cedar: permit if amount ≤ limit and facts.customer.verified
    alt allow
        Gateway->>Upstream: tools/call stripe.refund {customer_id, amount}
        Upstream-->>Gateway: {refund_id, status}
    else deny
        Note over Gateway: no upstream call is made
    end
    Gateway->>Gateway: build in-toto statement, sign (DSSE, Ed25519)
    Gateway->>Log: append canonical envelope
    Log-->>Gateway: leaf index, inclusion proof, root
    Gateway->>Gateway: sign tree head, write bundle to receipts/
    Gateway-->>Agent: result or denial, _meta["agent-receipts/receipt"] = id
```

Denied calls get receipts too. "The agent tried to pay out funds and was refused" is evidence worth keeping.

## Anatomy of a receipt bundle

```mermaid
flowchart TB
    B["receipt bundle (one JSON file)"]
    B --> E["envelope: DSSE, signed by gateway key"]
    B --> T["treeHead: DSSE, signed by gateway key<br/>{treeSize, rootHash, timestamp}"]
    B --> I["inclusion: {leafIndex, treeSize, hashes[]}"]
    E --> S["in-toto Statement v1"]
    S --> SU["subject: tool-call:&lt;tool&gt;:&lt;id&gt;<br/>digest = sha256(args)"]
    S --> PR["predicate"]
    PR --> P0["issuer: gateway or sdk, keyid, framework"]
    PR --> P1["principal, agent, delegation<br/><b>attested</b>: signed by principal key (gateway)"]
    PR --> P2["tool, facts, policy decision, execution<br/><b>observed</b>: gateway obtained it (gateway)"]
    PR --> P3["args, model id, session<br/><b>claimed</b>: agent-supplied, unchecked (both)<br/>every field, when issued by the sdk"]
```

Every field carries a provenance label. This is the design decision that matters most, and it is what a verifier reads back.

| provenance | meaning | today's examples |
| --- | --- | --- |
| `attested` | signed by a key other than the issuer's | principal id, agent id, the delegation grant (gateway receipts) |
| `observed` | the issuer obtained it deterministically, outside the agent's control | upstream tool results, fact lookups, the policy decision, execution status (gateway receipts) |
| `claimed` | originated from the agent, the model, or the agent's own process, no independent check | tool arguments, the model id, session ids, and every field of an SDK receipt |

## Quick start

```bash
bun install        # or pnpm / npm
npm run demo       # gateway: keys, grant, policy, four tool calls, verification, a tampering attempt; then the SDK wrapping the same tool
npm test
```

The demo leaves everything in `demo-out/`, including receipts from both producers. Verify a receipt by hand:

```bash
node src/cli.ts verify demo-out/receipts/<id>.json \
  --issuer-key demo-out/keys/gateway.pub \
  --principal-key demo-out/keys/principal.pub \
  --log demo-out/log.jsonl
```

Exit code 0 means every check passed. See [docs/verification.md](docs/verification.md) for what the report means.

To issue receipts from your own agent code, without a gateway:

```ts
import { loadSdkConfig } from "./src/config.ts";
import { createSdkIssuer } from "./src/sdk/index.ts";

const issuer = createSdkIssuer(loadSdkConfig("./sdk.json"));
const refund = issuer.wrap("stripe.refund", async (args: { amount: number }) => stripe.refund(args));
```

[docs/sdk.md](docs/sdk.md) has the config file and the per-framework adapters.

## What a receipt proves, and what it does not

| claim | verifier | adversary | mechanism | status |
| --- | --- | --- | --- | --- |
| receipt was not altered after issue | anyone | later editor | DSSE signature over canonical JSON | done |
| receipt was issued in sequence, none removed | auditor with a log copy | operator rewriting history | Merkle inclusion proof + recomputed root | done |
| the principal really delegated this scope to this agent | anyone with the principal's key | operator, agent | grant signed by principal key, checked for scope and validity window | done |
| the policy decision was made against this exact policy | anyone | operator swapping policies | sha256 of policy text in the receipt | done |
| facts the policy relied on were not asserted by the agent | anyone reading the receipt | agent | facts fetched by the gateway, recorded with their own digests, labelled `observed` | done |
| the upstream system actually executed the action | third party | operator | needs the upstream's own signed response embedded verbatim | **not done**, depends on the tool provider |
| the operator itself cannot mint a false receipt | regulator, counterparty | operator | needs a TEE-hosted signer or a federated log | **not done** |
| which model produced the call | anyone | operator | no hosted provider signs model identity | **not possible today**, labelled `claimed` |
| an SDK receipt reflects what the tool really did | anyone | agent's own process | none; the SDK shares a process with the agent | **by design not claimed**; issuer kind `sdk` says so |

If a vendor tells you their receipts prove more than the first five rows, ask them which key signed it.

## Layout

```
src/config.ts      gateway and SDK config schemas, path resolution
src/crypto.ts      canonical JSON, sha256, Ed25519 keys, DSSE sign/verify
src/log.ts         Merkle log: append, root, inclusion proof, verify, JSONL persistence
src/policy.ts      Cedar evaluation wrapper, fail-closed
src/delegation.ts  signed delegation grants
src/receipt.ts     receipt statement types and provenance labels
src/issue.ts       sign, log, and write a receipt; shared by both producers
src/gateway.ts     the MCP proxy: scope check, facts, policy, forward, receipt
src/sdk/index.ts   the interceptor: policy decision, record, wrap(tool fn)
src/sdk/claude.ts  Claude Code command hook and Claude Agent SDK in-process hooks
src/sdk/openai-agents.ts, vercel-ai.ts, langchain.ts   framework adapters, tested against the real packages
src/verify.ts      offline verification and the human-readable report
src/cli.ts         keygen, grant, gateway, hook, verify
scripts/           fake Stripe upstream, fixture builders for gateway and SDK, demo
test/              unit tests per module, end-to-end gateway test, SDK and hook tests,
                   adapter tests against the real packages, and a test that runs every policy in docs/policies.md
docs/              usage (gateway), sdk, policies, verification
```

## Plan

The design is two producers feeding one verifier. The SDK is the top of the funnel: cheap to install, wide reach, honest about being self-reported. The gateway is what a security or compliance owner mandates for consequential actions. Both exist; the work is widening each.

**Done**

- Gateway: MCP proxy, signed delegation, gateway-fetched facts, Cedar policy, denial receipts, Merkle log, offline verifier.
- Receipt schema carries the issuer kind, so a verifier reads gateway versus SDK before anything else.
- SDK core: policy decision, record, and a generic `wrap(tool, fn)` for any framework whose tools are functions.
- Claude Code command hook for PreToolUse, PostToolUse, and PostToolUseFailure, with blocking on deny.
- Claude Agent SDK in-process hooks over the same handler.
- Framework adapters, each tested against the real package with a scripted model and no network: OpenAI Agents SDK (`wrapTools` enforces, `observeRunner` records from lifecycle events), Vercel AI SDK (`wrapTools` over a real `generateText` loop), LangChain (`ReceiptCallbackHandler` records, `issuer.wrap` enforces).

**Next, in the order it pays off**

1. OpenTelemetry export: emit each receipt as a span with the receipt id and issuer kind as attributes, so existing collectors and dashboards carry them without a new pipeline.
2. Embed upstream signed responses (Stripe webhook signatures, GitHub delivery signatures) so gateway execution can move from `observed` to `attested`.
3. Consistency proofs between tree heads, so an auditor can check that a later log extends an earlier copy.
4. An HTTP transport for the gateway, with the grant presented per connection, for a shared deployment rather than one process per agent session.
5. Delegation chains for sub-agents.
6. Receiver-attested receipts for agent-to-agent calls.
7. A TEE-hosted signer, then SD-JWT redaction, then ZK proofs of policy compliance. Not before.

A Python SDK follows the same shape once the TypeScript adapters have settled.

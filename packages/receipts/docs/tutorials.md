# Tutorials

One runnable example per aspect of the code. Each prints what it is doing, step by step, and ends with `OK`. The test suite runs all of them, so what you read here is what the code does today.

```bash
node examples/01-keys-and-signing.ts
```

Suggested reading order is the numbering. Output lands in `examples-out/`, which is gitignored.

| # | aspect | file | you will see | source |
| --- | --- | --- | --- | --- |
| 01 | identities and signatures | [01-keys-and-signing.ts](../examples/01-keys-and-signing.ts) | key generation, keyids, a DSSE envelope, verification with the public key, a tampered payload rejected | `src/crypto.ts` |
| 02 | delegated authority | [02-delegation-grant.ts](../examples/02-delegation-grant.ts) | a principal signs a grant, a stranger's key is rejected, validity windows, scopes | `src/delegation.ts` |
| 03 | policies | [03-policies.ts](../examples/03-policies.ts) | a Cedar policy evaluated against eight calls: reads, limits, gateway facts versus agent claims, forbid, floats, default deny, the policy digest | `src/policy.ts` |
| 04 | the transparency log | [04-merkle-log.ts](../examples/04-merkle-log.ts) | appends, inclusion proofs, recomputing the root from the file, an edited line detected | `src/log.ts` |
| 05 | the gateway | [05-gateway.ts](../examples/05-gateway.ts) | an MCP client connects to the gateway over stdio, sees filtered tools, gets one execution and one denial with receipt ids | `src/gateway.ts`, `src/cli.ts` |
| 06 | verification and auditing | [06-verify-and-audit.ts](../examples/06-verify-and-audit.ts) | the full check list, with and without a log copy, a tampered receipt, an untrusted key, checks as data for CI | `src/verify.ts` |
| 07 | the in-process SDK | [07-sdk-wrap.ts](../examples/07-sdk-wrap.ts) | wrap a function, allowed and denied and errored calls, the decide/record primitives, an SDK receipt's report | `src/sdk/index.ts` |
| 08 | Claude Code and Agent SDK hooks | [08-claude-code-hook.ts](../examples/08-claude-code-hook.ts) | the settings.json entry, PreToolUse allow and deny, PostToolUse, the real command over stdin, Agent SDK hooks | `src/sdk/claude.ts` |
| 09 | OpenAI Agents SDK | [09-openai-agents.ts](../examples/09-openai-agents.ts) | a real Runner with a scripted model, enforcement via wrapped tools, what the model sees on deny, record-only via lifecycle events | `src/sdk/openai-agents.ts` |
| 10 | Vercel AI SDK | [10-vercel-ai.ts](../examples/10-vercel-ai.ts) | a real generateText loop over the SDK's mock model, a denial as a tool-error part | `src/sdk/vercel-ai.ts` |
| 11 | LangChain | [11-langchain.ts](../examples/11-langchain.ts) | the callback handler, tool_call ids, enforcement by wrapping the function | `src/sdk/langchain.ts` |
| 12 | inside a receipt | [12-read-a-receipt.ts](../examples/12-read-a-receipt.ts) | the bundle's three parts, the in-toto statement, every predicate field with its provenance, the tree head | `src/receipt.ts` |
| 13 | a log run by someone else | [13-remote-log.ts](../examples/13-remote-log.ts) | the reference log server on a free port, an SDK config that logs to it, a tree head signed by the log's key, verification failing without that key and passing with it, the root endpoint, a refused token | `src/log-sink.ts` |
| 14 | proving history was not rewritten | [14-audit-history.ts](../examples/14-audit-history.ts) | three receipts and a kept tree head, a consistency proof that passes, the operator rewriting one leaf and appending a fourth call, the audit failing while the fourth receipt still verifies alone | `src/log.ts`, `src/verify.ts` |
| 15 | agents in other languages | [15-sidecar.ts](../examples/15-sidecar.ts) | the sidecar on a free port, a client written as a Python or Go program would write it: decide, run, record; a denial recorded without running the tool; both receipts verified | `src/sidecar.ts` |
| 16 | consequential tools, committed first | [16-precommit.ts](../examples/16-precommit.ts) | a refund named in `precommit`: the authorization leaf before the receipt leaf, the five authorization checks in the report, and the same call withheld when the log refuses | `src/gateway.ts`, `src/issue.ts`, `src/verify.ts` |
| 17 | a REST API as an upstream | [17-rest-upstream.ts](../examples/17-rest-upstream.ts) | a stand-in payments API described as two tools, the token from the environment, a refund allowed on the gateway's own lookup and one denied before reaching the API, the receipt verified | `src/rest.ts`, `src/gateway.ts` |

## How policies are defined, in one paragraph

A policy is a Cedar file. The gateway turns each tool call into a Cedar request: the principal is `Agent::"<agent id from the grant>"`, the action and resource are the tool name, and the context has three parts. `context.args` is what the agent sent and is only ever claimed. `context.facts` is what the gateway fetched itself before deciding, configured per tool in `gateway.json`, and is observed. `context.grant` is the signed delegation and is attested. Nothing matches means deny. A `forbid` beats every `permit`. An evaluation error, such as a missing attribute or a float, is a deny and is written into the receipt. The receipt also carries the sha256 of the policy text, so a verifier knows exactly which policy decided. Example 03 runs one; [policies.md](policies.md) has nine more, each executed by the test suite.

## Where each guide goes deeper

- [usage.md](usage.md): gateway setup and wiring into hosts
- [sdk.md](sdk.md): the interceptor and every adapter
- [policies.md](policies.md): the Cedar mapping, evaluation rules, tested examples, gotchas
- [verification.md](verification.md): every check and what a verified receipt does and does not prove

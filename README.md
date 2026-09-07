# agent-custody

Chain of custody for AI agents: what an agent did and what it believes, signed, independently verifiable, and revertible.

The agent is not trusted. The layer around it is, and every record says exactly how far that trust extends.

## Packages

| package | what it is | status |
| --- | --- | --- |
| [`@agent-custody/receipts`](packages/receipts/README.md) | Signed receipts for tool calls: an MCP gateway with Cedar policy and a Merkle transparency log, an in-process SDK with framework adapters, and an offline verifier | working, fourteen runnable tutorials |
| [`agent-custody` on PyPI](packages/python/README.md) | The Python client of the sidecar: `decide`, `record`, `wrap`, and adapters for LangChain, the OpenAI Agents SDK, and the Claude Agent SDK, tested against the real packages | working; Go, Java, and Rust clients live in [examples/languages](packages/receipts/examples/languages) |
| [`@agent-custody/state`](packages/state/README.md) | Governed memory: a fact ledger where every write cites the receipt that caused it, carries valid time and transaction time, and can be superseded or rolled back | ledger, memory server behind the gateway, quarantine, blast radius, write-through to Mem0 and Zep, eval harness |

Receipts are the unit. State is the ledger of what the agent came to believe from them. Both append to the same kind of signed log and are checked by the same kind of verifier.

## What each piece is for, and when you need it

<!-- #region pieces -->
Each part exists because a specific thing goes wrong without it. Use the table to decide what to turn on.

| piece | the failure it prevents | you need it when |
| --- | --- | --- |
| **SDK interceptor** (`@agent-custody/receipts`, in the agent's process) | The only record of what an agent did is its own log: mutable, unsigned, written by the thing you are trying to check. | Any agent that calls tools. Turn it on first; it is a hook or a wrapped function. It is honest about being self-reported: every field is labelled `claimed`. |
| **Gateway** (`@agent-custody/receipts`, a separate process between agent and tools) | An in-process hook can be skipped, and a policy that reads the agent's own arguments can be fed lies. | The call moves money, touches production, or handles personal data, or a security owner has to sign off on what agents may do. Denied calls never reach the tool and still produce a receipt. |
| **Delegation grant and Cedar policy** (used by the gateway) | "The agent was allowed to do that" is a comment in a config file, not something a human signed. | Always with the gateway. The grant is signed by the principal and names agent, tools, and validity window; the policy decides on facts the gateway fetched itself, never on the agent's claims. |
| **Transparency log** (local file, automatic) | A signed receipt can be deleted or replaced after the fact and nobody would know. | Always; every receipt is a leaf with an inclusion proof. Costs nothing to use. |
| **Remote log** (`log` in the config, plus the `log` command or a hosted log) | The operator holds the local log file and can rewrite history in it. | A receipt will be shown to someone who does not trust the operator: an auditor, a counterparty, a customer, a regulator. The log's key, not yours, signs the tree heads. |
| **Verifier** (`verify` and `audit` commands, or `verifyBundle`) | Trust that depends on access to the system that produced the record is not trust. | Whenever a receipt leaves the team that made it: an audit, a CI gate, acceptance by the other side of an agent-to-agent call. It needs public keys and nothing else. |
| **State ledger** (`@agent-custody/state`) | Agents act on beliefs. A wrong belief spreads to other agents, cannot be traced to its source, and is overwritten rather than corrected, so "what did it believe on Tuesday" has no answer. | The agent remembers across sessions, shares memory with other agents, or takes actions whose justification you may later have to explain or undo. Every belief cites the receipt that produced it, is superseded rather than overwritten, and is retracted rather than deleted. |
| **Quarantine and provenance levels** (the memory server) | A self-reported write, or a value copied from an untrusted tool result, becomes something the whole fleet believes. | Any agent writes memory without going through the gateway, or writes values it got from tools. Claimed facts stay hidden until an attested party confirms them; a write can cite what the gateway itself fetched and is then verified, or refused. |
| **Blast radius** (`blast`) | A belief turns out wrong and nobody can say which actions were taken on it or which later beliefs came from it. | Before any cleanup after a bad write. Every receipt records what the agent had been shown; the query walks forward to every call and derived belief, with the retraction status. |
| **Certified forget, retention, legal hold** (the memory server) | A deletion demand is answered with "we think it's gone". Retention is a policy document, not something that runs. A hold is an email. | Personal data in memory, a regulator or customer with a deletion right, or a matter under litigation. Forget erases the value from the ledger and every store and the receipt is the certificate; sweeps run retention as receipted calls; a hold refuses both until released. |
| **Write-through to Mem0 and Zep** | The team already runs a retrieval store, and governing memory would mean replacing it. | Any existing Mem0 or Zep deployment. The ledger sits under it: writes land in the store with custody metadata, retractions and forgets reach it, and recall stays where it was. |
| **Eval harness** | "Our memory is governed" is a claim with no number behind it. | Before a design review or a vendor comparison. Scripted incidents score stale reads, contradictions, and blast radius for this ledger and for any store behind the same interface. |

The rule of thumb: record everything with the SDK, enforce the consequential calls with the gateway, log remotely once a receipt has an audience outside the team, put beliefs in the ledger the moment memory outlives a session, and turn on quarantine, forget, and holds the moment that memory holds anything about a person.
<!-- #endregion pieces -->

## Getting started

<!-- #region getting-started -->

Node 22 or later. Both packages ship compiled JavaScript with type declarations.

```bash
npm install @agent-custody/receipts @agent-custody/state
```

**1. Give the agent's process a signing key and a config.** The key signs every receipt. The config says where receipts and the log go.

```bash
npx agent-custody keygen --dir keys --name app
```

```json
{ "agentId": "support-bot", "identity": { "keyFile": "keys/app.key" }, "receiptsDir": "receipts", "logFile": "log.jsonl" }
```

**2. Record a tool call as a receipt.** Wrap the functions the agent calls, or record a call explicitly. Either way a signed receipt lands in `receipts/` and a leaf in the Merkle log.

```ts
import { createSdkIssuer, loadSdkConfig } from "@agent-custody/receipts";

const issuer = createSdkIssuer(loadSdkConfig("./sdk.json"));

const lookup = issuer.wrap("crm.lookup", async (args: { id: string }) => crm.lookup(args));   // records every call
const customer = await lookup({ id: "acct:42" });

const bundle = issuer.record({ tool: "crm.lookup", args: { id: "acct:42" } }, { status: "executed", result: customer });   // or record one by hand and keep the bundle
```

**3. Verify it, offline.** Anyone with the public key and a copy of the log can check the signature, the statement, and the inclusion proof. No access to the agent or the issuer needed.

```ts
import { loadPublicKey, verifyBundle } from "@agent-custody/receipts";

verifyBundle(bundle, { issuerKeys: [loadPublicKey("keys/app.pub")], principalKeys: [], logFile: "log.jsonl" }).ok;   // true
```

```bash
npx agent-custody verify receipts/<id>.json --issuer-key keys/app.pub --log log.jsonl    # the same check from the shell
```

**4. Record what the agent now believes, citing the receipt.** The ledger is bitemporal: it knows when a fact was true and when the agent learned it. A belief points back at the receipt that produced it.

```ts
import { receiptIdOf } from "@agent-custody/receipts";
import { Ledger } from "@agent-custody/state";

const ledger = new Ledger("./ledger.jsonl");
const belief = ledger.assert({ subject: "acct:42", predicate: "plan", value: customer.plan, space: "org", actor: "support-bot", source: { receiptId: receiptIdOf(bundle) } });
```

**5. When a belief is wrong, undo it without losing the record.** Retract removes it from the present, keeps it visible to questions about the past, and restores whatever it had superseded. The receipt id says exactly which call produced the bad belief.

```ts
ledger.retract({ factId: belief.fact.factId, actor: "user:admin", reason: "CRM lookup returned a stale plan" });
ledger.asOf({ subject: "acct:42" });                                                        // [] now
ledger.asOf({ subject: "acct:42", validAt: earlier, txAt: earlier });                        // still shows what was believed then
ledger.history(belief.fact.factId);                                                          // assert, retract, with actors and reasons
```

This whole loop is one runnable file, [packages/state/examples/02-receipt-to-belief.ts](packages/state/examples/02-receipt-to-belief.ts), executed by the test suite.
<!-- #endregion getting-started -->

**Where to go next**

- Enforce instead of record: put the gateway between the agent and its MCP tools, with a signed delegation grant and a Cedar policy. Denied calls never reach the tool and still get a receipt. [packages/receipts/docs/usage.md](packages/receipts/docs/usage.md)
- Hook an existing framework: Claude Code and the Claude Agent SDK, the OpenAI Agents SDK, the Vercel AI SDK, LangChain. [packages/receipts/docs/sdk.md](packages/receipts/docs/sdk.md)
- Write policies and read what a verified receipt does and does not prove. [policies.md](packages/receipts/docs/policies.md), [verification.md](packages/receipts/docs/verification.md)
- Log to a server the operator does not control, so tree heads are signed by a key that is not yours. [verification.md](packages/receipts/docs/verification.md)
- Verify a receipt in the browser, nothing uploaded, and check a second implementation against the published conformance vectors. [agent-custody.dev/verify](https://agent-custody.dev/verify), [vectors](https://agent-custody.dev/receipt/vectors)
- Prove a log was never rewritten: keep any receipt's tree head, later audit that the log still extends it. [verification.md](packages/receipts/docs/verification.md)
- Want the hosted log, run by someone who is not you? [Early access](https://agent-custody.dev/early-access).
- Agents in Python, Go, Java, Rust, or anything else: the gateway is an MCP server and needs nothing from your language; for in-process receipts run the sidecar and use the Python package or a forty-line client. [sdk.md](packages/receipts/docs/sdk.md#other-languages-the-sidecar)
- Seventeen step-by-step examples across the packages: [receipts tutorials](packages/receipts/docs/tutorials.md), [state examples](packages/state/examples).

## Working in the repository

```bash
bun install                         # one install for the whole workspace
bun run test                        # every package
bun run build                       # dist/ for every package, what consumers install
bun run test:python                 # the Python package, with uv; needs node for the sidecar
bun run demo                        # the receipts demo: keys, grant, policy, tool calls, verification, a tampering attempt
```

Everything runs on plain Node 22 or later. No build step. Package-level commands, such as the CLI and the tutorials, run from inside that package's directory; each package README says how.

## Layout

```
package.json          workspace root: typecheck, test, and demo across packages
tsconfig.base.json    compiler options shared by every package
packages/receipts/    the receipts package: src, test, examples, scripts, docs
packages/python/      the Python client package: agent_custody, tests run with uv against a real sidecar
packages/state/       the state package: src, test, examples
site/                 the website, generated from this repository's markdown by VitePress
```

## Plan

The receipts package's roadmap is in [its README](packages/receipts/README.md#plan). The state package has the ledger, the memory server behind the gateway, quarantine, consumed facts and blast radius, write-through to Mem0 and Zep, and the eval harness; next, in order: Cedar policy over provenance so a claimed write cannot displace an attested fact, then signed forget statements that reach every store, then a shared memory server over HTTP.

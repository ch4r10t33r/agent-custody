# agent-custody

Chain of custody for AI agents: what an agent did and what it believes, signed, independently verifiable, and revertible.

The agent is not trusted. The layer around it is, and every record says exactly how far that trust extends.

## Packages

| package | what it is | status |
| --- | --- | --- |
| [`@agent-custody/receipts`](packages/receipts/README.md) | Signed receipts for tool calls: an MCP gateway with Cedar policy and a Merkle transparency log, an in-process SDK with framework adapters, and an offline verifier | working, twelve runnable tutorials |
| [`@agent-custody/state`](packages/state/README.md) | Governed memory: a fact ledger where every write cites the receipt that caused it, carries valid time and transaction time, and can be superseded or rolled back | bitemporal fact ledger with supersession, retraction, and as-of queries |

Receipts are the unit. State is the ledger of what the agent came to believe from them. Both append to the same kind of signed log and are checked by the same kind of verifier.

## Getting started

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

**Where to go next**

- Enforce instead of record: put the gateway between the agent and its MCP tools, with a signed delegation grant and a Cedar policy. Denied calls never reach the tool and still get a receipt. [packages/receipts/docs/usage.md](packages/receipts/docs/usage.md)
- Hook an existing framework: Claude Code and the Claude Agent SDK, the OpenAI Agents SDK, the Vercel AI SDK, LangChain. [packages/receipts/docs/sdk.md](packages/receipts/docs/sdk.md)
- Write policies and read what a verified receipt does and does not prove. [policies.md](packages/receipts/docs/policies.md), [verification.md](packages/receipts/docs/verification.md)
- Thirteen step-by-step examples across the two packages: [receipts tutorials](packages/receipts/docs/tutorials.md), [state examples](packages/state/examples).

## Working in the repository

```bash
bun install                         # one install for the whole workspace
bun run test                        # every package
bun run build                       # dist/ for every package, what consumers install
bun run demo                        # the receipts demo: keys, grant, policy, tool calls, verification, a tampering attempt
```

Everything runs on plain Node 22 or later. No build step. Package-level commands, such as the CLI and the tutorials, run from inside that package's directory; each package README says how.

## Layout

```
package.json          workspace root: typecheck, test, and demo across packages
tsconfig.base.json    compiler options shared by every package
packages/receipts/    the receipts package: src, test, examples, scripts, docs
packages/state/       the state package: src, test, examples
```

## Plan

The receipts package's roadmap is in [its README](packages/receipts/README.md#plan). The state package is being built in this order: fact schema and ledger with as-of queries and supersession; a memory MCP server that runs behind the receipts gateway so every write and read is receipted and policy-checked; a consumed-facts field on receipts so the blast radius of a wrong fact can be queried; write-through adapters for existing memory stores; signed forget statements.

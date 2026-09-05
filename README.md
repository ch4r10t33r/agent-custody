# agent-custody

Chain of custody for AI agents: what an agent did and what it believes, signed, independently verifiable, and revertible.

The agent is not trusted. The layer around it is, and every record says exactly how far that trust extends.

## Packages

| package | what it is | status |
| --- | --- | --- |
| [`@agent-custody/receipts`](packages/receipts/README.md) | Signed receipts for tool calls: an MCP gateway with Cedar policy and a Merkle transparency log, an in-process SDK with framework adapters, and an offline verifier | working, twelve runnable tutorials |
| [`@agent-custody/state`](packages/state/README.md) | Governed memory: a fact ledger where every write cites the receipt that caused it, carries valid time and transaction time, and can be superseded or rolled back | started |

Receipts are the unit. State is the ledger of what the agent came to believe from them. Both append to the same kind of signed log and are checked by the same kind of verifier.

## Quick start

```bash
bun install                         # one install for the whole workspace
bun run test                        # every package
bun run demo                        # the receipts demo: keys, grant, policy, tool calls, verification, a tampering attempt
```

Everything runs on plain Node 22 or later. No build step. Package-level commands, such as the CLI and the tutorials, run from inside that package's directory; each package README says how.

## Layout

```
package.json          workspace root: typecheck, test, and demo across packages
tsconfig.base.json    compiler options shared by every package
packages/receipts/    the receipts package: src, test, examples, scripts, docs
packages/state/       the state package: src, test
```

## Plan

The receipts package's roadmap is in [its README](packages/receipts/README.md#plan). The state package is being built in this order: fact schema and ledger with as-of queries and supersession; a memory MCP server that runs behind the receipts gateway so every write and read is receipted and policy-checked; a consumed-facts field on receipts so the blast radius of a wrong fact can be queried; write-through adapters for existing memory stores; signed forget statements.

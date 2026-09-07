# @agent-custody/state

Governed memory for AI agents. Not a vector store: a ledger of facts where every write cites the receipt that caused it, carries valid time and transaction time, and can be superseded or retracted without losing what the agent believed at any earlier moment.

Retrieval stays with whatever store you already use. This package owns provenance, time, and undo.

## Getting started

```bash
npm install @agent-custody/state           # or bun add, pnpm add
```

Published on npm as [`@agent-custody/state`](https://www.npmjs.com/package/@agent-custody/state): compiled JavaScript with type declarations, Node 22 or later, Apache-2.0.

```ts
import { Ledger } from "@agent-custody/state";

const ledger = new Ledger("./state/ledger.jsonl");
const a = ledger.assert({ subject: "acct:42", predicate: "plan", value: "pro", space: "org", actor: "agent:support", source: { receiptId } });
ledger.assert({ subject: "acct:42", predicate: "plan", value: "enterprise", space: "org", actor: "agent:sales", supersedes: a.fact.factId });
ledger.retract({ factId: a.fact.factId, actor: "user:admin", reason: "poisoned by a tool result" });
ledger.asOf({ validAt: "2026-09-01T00:00:00Z", txAt: "2026-09-01T00:00:00Z" });
```

Three runnable examples, all executed by the test suite. [03-memory-behind-the-gateway.ts](examples/03-memory-behind-the-gateway.ts) runs the memory server as the gateway's upstream. [01-ledger.ts](examples/01-ledger.ts) walks through a wrong write and its undo. [02-receipt-to-belief.ts](examples/02-receipt-to-belief.ts) runs the whole loop with the receipts package: a tool call gets a signed receipt, the receipt is verified, the belief taken from it is recorded citing the receipt, and later retracted. Run them with `node examples/<file>` from this directory, after `bun run build` at the repository root.

## The memory server

The ledger as MCP tools, meant to run as the upstream of the receipts gateway. Behind the gateway, every write and read is checked by the Cedar policy and gets a signed receipt, and two things reach this server in the call's `_meta` that no caller can supply: the receipt id, which becomes the fact's `source`, and the agent from the signed delegation grant, which becomes the fact's `actor`. A caller's own claims about either are ignored.

```bash
agent-custody-memory serve --ledger ./ledger.jsonl        # over stdio; refuses calls that did not come through the gateway
```

In the gateway's config, the memory server is the upstream, and the grant names the memory tools as scopes:

```json
{ "upstream": { "command": "agent-custody-memory", "args": ["serve", "--ledger", "/abs/path/ledger.jsonl"] }, ... }
```

| tool | does | policy sees |
| --- | --- | --- |
| `memory.write` | records a belief in a space, optionally superseding an earlier fact | `context.args.space`, `subject`, `predicate`, `value` |
| `memory.read` | the facts believed at a moment, by space, subject, predicate, valid time, transaction time | the query |
| `memory.retract` | undoes a belief, keeping it visible to questions about the past | `factId`, `reason` |
| `memory.history` | every event that touched a fact | `factId` |

Trust tiers are Cedar policies over the space: `permit(principal, action == Action::"memory.write", resource) when { context.args.space == "team:support" };` lets this agent write team memory and nothing else. A read's receipt carries, as `observed`, the exact facts returned, so the ids the agent relied on are already on the record.

`--allow-direct` lets the server take calls without a gateway; then `source.receiptId` is null and `actor` is whatever the caller said, recorded as such. [examples/03-memory-behind-the-gateway.ts](examples/03-memory-behind-the-gateway.ts) runs the whole loop, including a denied write and a retraction that cites its own receipt.

## The ledger

`src/ledger.ts` is an append-only JSONL log of two kinds of event.

- **assert** creates a fact: subject, predicate, value, the space it lives in (a person, a team, an org), the actor that wrote it, the source receipt id if the write went through a receipts producer, and the valid-time interval. An assert may **supersede** an earlier fact, which ends that fact's validity where the new one begins.
- **retract** says a fact should never have been believed. This is the undo. The record stays, so queries about earlier moments still see the fact, and anything the retracted fact had superseded is believed again.

Two clocks, kept apart on purpose:

| | question it answers | set by |
| --- | --- | --- |
| valid time | was this true in the world at T | the writer, defaults to now |
| transaction time | did the ledger know it at T | the ledger, never the writer |

`asOf({ validAt, txAt, space, subject, predicate })` returns the facts believed at a moment. Setting both times to the same instant answers "what did the agent believe on Tuesday", including beliefs later retracted. `history(factId)` returns every event that touched a fact.

The ledger refuses to supersede a fact that is unknown, already superseded, or retracted, and refuses a replacement whose validity starts before the fact it replaces.

## Layout

```
src/ledger.ts   the fact record, the two event kinds, as-of queries, supersession, retraction, JSONL persistence
src/server.ts   the ledger as MCP tools; source and actor taken from the gateway's _meta
src/cli.ts      agent-custody-memory serve
src/index.ts    public surface
examples/       runnable walkthroughs, each ends with OK and is run by the test suite
test/           one test per question a platform owner asks after a memory incident
tsconfig.build.json  emits dist/ for consumers; the repo itself runs the .ts directly
```

## Plan

**Done**

- Bitemporal fact ledger with supersession, retraction, as-of and history queries, persisted as JSONL.
- The memory server: the ledger as MCP tools behind the receipts gateway, with the source receipt id and the attested actor supplied by the gateway, policy over spaces, and a denial receipt for every refused write.

**Next, in the order it pays off**

1. A consumed-facts field on receipts: the gateway records which fact ids a read returned, so later receipts in the session show what the agent relied on.
2. Blast radius: given a fact id, every downstream receipt and derived fact that cited it.
3. Trust tiers as Cedar policies over spaces and receipt provenance: a self-reported write cannot overwrite an org-space fact that was attested through the gateway.
4. Write-through adapters for existing memory stores, tested against the real packages.
5. Signed forget statements: a retention or deletion request produces a verifiable record of which facts were removed.

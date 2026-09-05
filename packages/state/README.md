# @agent-custody/state

Governed memory for AI agents. Not a vector store: a ledger of facts where every write cites the receipt that caused it, carries valid time and transaction time, and can be superseded or retracted without losing what the agent believed at any earlier moment.

Retrieval stays with whatever store you already use. This package owns provenance, time, and undo.

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

```ts
import { Ledger } from "@agent-custody/state/src/index.ts";

const ledger = new Ledger("./state/ledger.jsonl");
const a = ledger.assert({ subject: "acct:42", predicate: "plan", value: "pro", space: "org", actor: "agent:support", source: { receiptId } });
ledger.assert({ subject: "acct:42", predicate: "plan", value: "enterprise", space: "org", actor: "agent:sales", supersedes: a.fact.factId });
ledger.retract({ factId: a.fact.factId, actor: "user:admin", reason: "poisoned by a tool result" });
ledger.asOf({ validAt: "2026-09-01T00:00:00Z", txAt: "2026-09-01T00:00:00Z" });
```

The ledger refuses to supersede a fact that is unknown, already superseded, or retracted, and refuses a replacement whose validity starts before the fact it replaces.

## Layout

```
src/ledger.ts   the fact record, the two event kinds, as-of queries, supersession, retraction, JSONL persistence
src/index.ts    public surface
test/           one test per question a platform owner asks after a memory incident
```

## Plan

**Done**

- Bitemporal fact ledger with supersession, retraction, as-of and history queries, persisted as JSONL.

**Next, in the order it pays off**

1. A memory MCP server exposing write, read, supersede, and forget as tools, run behind the receipts gateway so every call is receipted and policy-checked and the source receipt id is filled in by the gateway rather than the caller.
2. A consumed-facts field on receipts: the gateway records which fact ids a read returned, so later receipts in the session show what the agent relied on.
3. Blast radius: given a fact id, every downstream receipt and derived fact that cited it.
4. Trust tiers as Cedar policies over spaces and receipt provenance: a self-reported write cannot overwrite an org-space fact that was attested through the gateway.
5. Write-through adapters for existing memory stores, tested against the real packages.
6. Signed forget statements: a retention or deletion request produces a verifiable record of which facts were removed.

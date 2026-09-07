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

Six runnable examples, all executed by the test suite. [06-actions-on-beliefs.ts](examples/06-actions-on-beliefs.ts) puts memory and a payments API behind one gateway and finds the refund in a belief's blast radius. [05-blast-radius.ts](examples/05-blast-radius.ts) walks from a retracted belief to everything that relied on it. [04-evals.ts](examples/04-evals.ts) scores the ledger and a naive store on the same memory incidents. [03-memory-behind-the-gateway.ts](examples/03-memory-behind-the-gateway.ts) runs the memory server as the gateway's upstream. [01-ledger.ts](examples/01-ledger.ts) walks through a wrong write and its undo. [02-receipt-to-belief.ts](examples/02-receipt-to-belief.ts) runs the whole loop with the receipts package: a tool call gets a signed receipt, the receipt is verified, the belief taken from it is recorded citing the receipt, and later retracted. Run them with `node examples/<file>` from this directory, after `bun run build` at the repository root.

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
| `memory.confirm` | lifts a quarantined fact to attested; accepted only through the gateway | `factId` |
| `memory.retract` | undoes a belief, keeping it visible to questions about the past | `factId`, `reason` |
| `memory.forget` | erases the value from the ledger and every store, keeping the digest; the receipt is the certificate | `factId`, `reason` |
| `memory.get` | one fact by id in any state, for the gateway's policy lookups | `factId` |
| `memory.history` | every event that touched a fact | `factId` |

**Quarantine.** Every fact carries a provenance: `claimed`, `attested`, or `verified`. A write that came through the gateway is `attested`: its actor is the agent named in a human-signed grant and its receipt exists. A write that arrived any other way is `claimed`, and claimed facts are quarantined: `memory.read` leaves them out unless the caller asks for `includeClaimed`, and the policy can refuse that. `memory.confirm`, accepted only through the gateway, lifts a claimed fact to attested with its own receipt and transaction time, so "was this fact still in quarantine on Tuesday" is answerable. A tool result an SDK-only agent wrote down cannot become something the rest of the fleet believes until an attested party says so. Over stdio the server has one client; shared over HTTP, below, gateways and direct writers feed one ledger and quarantine does its job.

**Value-level quarantine.** An attested write still carries whatever value the agent chose to write. When the agent can say where a value came from, the gateway's own observation decides. A `memory.write` may name `evidence: { fact, path }`, a fact the gateway fetched itself for this call through its fact-lookup mechanism (a CRM record, say) and optionally a field in it. The memory server compares the value with the observation: equal, and the fact is written as `verified`, the third provenance level, where both the actor and the value are vouched for by something other than the agent; different, and the write is refused. A policy can require evidence for a space (`context.args has evidence`), and `memory.read` with `requireVerified` returns only verified facts. The test suite runs this with a CRM lookup behind the same gateway as the memory server.

**Policy over the fact being changed.** The gateway can look up the fact a write supersedes or a retraction targets before deciding, through its fact-lookup mechanism and the `memory.get` tool, and the policy then sees that fact's space, actor, and provenance as observed facts. This is the second half of trust tiers: a self-reported note in the org space can be superseded by anyone the grant allows, while an attested org fact cannot be displaced or retracted except by whoever the policy names. In the gateway config:

```json
"facts": [
  { "name": "target", "tool": "memory.get", "args": { "factId": "$args.supersedes" }, "forTools": ["memory.write"], "optional": true },
  { "name": "target", "tool": "memory.get", "args": { "factId": "$args.factId" }, "forTools": ["memory.retract"] }
]
```

```cedar
forbid(principal, action in [Action::"memory.write", Action::"memory.retract"], resource)
when { context.facts has target && context.facts.target.space == "org" && context.facts.target.provenance == "attested" };
```

The lookup for writes is optional, so a write that supersedes nothing needs no lookup; the one for retractions is required. The denial receipt records the fact the policy saw, observed by the gateway. The test suite runs exactly this configuration.

**Attested executions.** Started with `--key memory.key`, the server signs every result for the receipt the gateway is issuing. A verifier given `memory.pub` then reports the execution of each memory call as attested by the memory server, not only observed by the gateway; the test suite verifies a write this way.

**Shared over HTTP.** `agent-custody-memory serve --ledger ./ledger.jsonl --http --port 8790 --token-env MEMORY_TOKEN` serves the same tools over Streamable HTTP, so several gateways, one per agent host, and, with `--allow-direct`, SDK-only agents share one ledger. That is the deployment quarantine was built for: writes arriving through a gateway are attested, writes arriving directly are claimed and hidden until a gateway confirms them, and the ledger tells them apart. A gateway reaches it with `"upstream": { "url": "http://127.0.0.1:8790/mcp", "tokenEnv": "MEMORY_TOKEN" }` in its config. Bind wider than loopback only behind the token. The test suite runs exactly this: one gateway writer, one direct writer, one ledger.

Trust tiers are Cedar policies over the space and, through `includeClaimed`, over quarantine: `permit(principal, action == Action::"memory.write", resource) when { context.args.space == "team:support" };` lets this agent write team memory and nothing else. A read's receipt carries, as `observed`, the exact facts returned, so the ids the agent relied on are already on the record.

`--allow-direct` lets the server take calls without a gateway; then `source.receiptId` is null and `actor` is whatever the caller said, recorded as such. [examples/03-memory-behind-the-gateway.ts](examples/03-memory-behind-the-gateway.ts) runs the whole loop, including a denied write and a retraction that cites its own receipt.

## Certified forget

A deletion demand is different from a correction. Retract keeps the record; forget erases the value. `memory.forget` removes the fact's value from the ledger file itself, replacing it with the value's digest so the ledger can still prove what it held without holding it, stops believing the fact, and removes it from every store behind the server. The result says exactly what happened: erased from the ledger, removed from which stores, still held by which, with the digest, the actor, and the reason.

The certificate is the receipt. Through the gateway, `memory.forget` is a receipted call whose result the gateway observed, so the signed, logged receipt records that the erasure happened, who asked for it, and what the stores answered. Hand that receipt to whoever demanded the deletion; anyone with the gateway's public key can verify it.

What forget does not reach, and the docs will not pretend otherwise: receipts. The receipt that recorded the original write carries the value in its request arguments, and the receipts of reads carry it in their results; they are signed and in a Merkle log, so they cannot be edited. Erasure from the receipt log is a retention policy on the log, and selective redaction of receipts is on the receipts roadmap.

## Blast radius

When a belief turns out wrong, the next question is what relied on it. Two records answer it together. Every gateway receipt carries `consumed`: the fact ids the agent had been shown, through the gateway, before that call, which the memory server declares on each read. Every fact in the ledger carries the receipt that wrote it. Walking forward from a fact through those two links gives every later call and every belief written in those calls, transitively, and whether the root was retracted and which derived beliefs are still believed.

```bash
agent-custody-memory blast --ledger ./ledger.jsonl --receipts ./receipts --fact <factId>
```

```
fact 3f2a…: acct:42 plan = "enterprise" (space team:support, by support-agent, attested)
retracted at 2026-09-07T10:12:04.118Z by support-agent: CRM sync bug: account is on the free plan
3 call(s) made after the agent was shown it:
  2026-09-07T10:12:03.902Z  memory.write       executed  receipt 7c1e…
  ...
2 belief(s) written in those calls, 2 still believed:
  acct:42 discount = "20%"  fact 9b04…  STILL BELIEVED
  acct:42 support_tier = "priority"  fact e77d…  STILL BELIEVED
```

With the gateway fronting several upstreams, memory and the tools the agent acts with, the radius reaches the actions too: a refund issued after the agent read a belief carries that belief's id and is listed. [examples/06-actions-on-beliefs.ts](examples/06-actions-on-beliefs.ts) shows it.

It is an upper bound by design: a call made after the agent had seen the fact is in the radius whether or not the agent used it, because no receipt can prove what a model attended to. What it never misses is the thing that matters, a downstream action or belief that did depend on the fact. [examples/05-blast-radius.ts](examples/05-blast-radius.ts) runs the whole loop.

## Write-through to the stores you already use

The ledger is not a retrieval store, and it does not try to be. `src/stores.ts` puts it under the ones teams already run: a fact written through the memory server also lands in every configured store, with its custody metadata (fact id, space, actor, provenance, receipt id), the store's own id is recorded on the fact, and a retraction reaches the store by that id. Certified forget will be built on this: a deletion is only real once it has reached the stores that serve recall.

```ts
import { MemoryClient } from "mem0ai";
import { ZepClient } from "@getzep/zep-cloud";
import { Ledger, createMemoryServer, mem0Store, zepStore } from "@agent-custody/state";

const stores = [
  mem0Store(new MemoryClient({ apiKey: process.env.MEM0_API_KEY! }), { userId: "user_42" }),   // infer is off: the memory is the fact, verbatim
  zepStore(new ZepClient({ apiKey: process.env.ZEP_API_KEY! }), { userId: "user_42" }),         // or { graphId } for a shared graph
];
createMemoryServer(new Ledger("./ledger.jsonl"), { stores });
```

Order matters and is fixed: the ledger's checks run first, so a write it would refuse never reaches a store; the stores are written next, so their ids can be recorded; the ledger appends last. A store that refuses the write fails the write and nothing is recorded anywhere. On retraction the ledger goes first, since custody must not depend on a store being up, and a store that fails to remove is named in the error so the caller knows recall may still serve the value. The adapters are typed structurally and carry no runtime dependency on either vendor; the tests drive the real `mem0ai` and `@getzep/zep-cloud` clients against fake endpoints, offline.

## Scoring memory mutations

`src/evals.ts` is a harness that scores a memory system on what goes wrong after writes, not on recall. A scenario is a script of writes, reads, supersessions, and retractions with the value a correct system returns at each read. The score counts stale reads (a value served after a correction was known), contradictions (two values for one subject and predicate at once), blast radius (reads that served a write the scenario marks as bad), and correct reads. Any system behind the small `MemoryUnderTest` interface can be scored; this ledger and a naive overwrite store ship as the two reference points, and [examples/04-evals.ts](examples/04-evals.ts) prints both reports side by side.

```ts
import { Ledger, ledgerUnderTest, runAll, SCENARIOS, formatReport } from "@agent-custody/state";
console.log(formatReport(await runAll(ledgerUnderTest(new Ledger("./ledger.jsonl")), SCENARIOS)));
```

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
src/http.ts     the memory server over Streamable HTTP with bearer auth, for a shared ledger
src/cli.ts      agent-custody-memory serve (stdio or --http), blast
src/blast.ts    blast radius: from receipts' consumed facts and the ledger's source receipts, forward
src/stores.ts   write-through adapters: Mem0 and Zep, and the Store interface for others
src/evals.ts    the memory-mutation harness: scenarios, scoring, report
src/evals-ledger.ts  the ledger and a naive overwrite store behind the harness interface
src/index.ts    public surface
examples/       runnable walkthroughs, each ends with OK and is run by the test suite
test/           one test per question a platform owner asks after a memory incident
tsconfig.build.json  emits dist/ for consumers; the repo itself runs the .ts directly
```

## Plan

**Done**

- Bitemporal fact ledger with supersession, retraction, as-of and history queries, persisted as JSONL.
- The memory server: the ledger as MCP tools behind the receipts gateway, with the source receipt id and the attested actor supplied by the gateway, policy over spaces, and a denial receipt for every refused write.
- Value-level quarantine: a write may cite a fact the gateway fetched itself; the value must match it and the fact is then `verified`, the provenance level above attested, or the write is refused.
- Attested executions: with a key, the memory server signs its results for the gateway's receipt, so a verifier holding its public key sees memory calls as attested.
- The memory server over HTTP: one ledger shared by several gateways and direct writers, bearer-token auth, quarantine live.
- Certified forget: `memory.forget` erases a value from the ledger file keeping its digest, stops believing it, removes it from every store, and reports exactly what happened; the gateway's receipt of that call is the certificate.
- Policy over provenance: the gateway looks up the fact a write supersedes or a retraction targets, so policy decides on its space, actor, and provenance; a claimed fact can be displaced, an attested org fact cannot.
- Consumed facts and blast radius: the memory server declares the facts it serves, the gateway records them on every later receipt, and `blast` walks from a fact to every downstream call and derived belief, transitively, with its retraction status.
- Write-through adapters for Mem0 and Zep: every write lands in the store with custody metadata, the store id is recorded on the fact, retractions reach the store, and failures are ordered so nothing is half-recorded.
- The memory-mutation eval harness: stale reads, contradictions, blast radius, and correct reads over scripted incidents, scored the same way for the ledger and for anything behind the same interface.
- Quarantine: facts carry `attested` or `claimed` provenance; claimed facts are hidden from reads by default and a gateway-only `memory.confirm` lifts them, as a recorded event.

**Next, in the order it pays off**

2. Retention windows and legal hold on the ledger: forget on a schedule, and a hold that refuses forget for named facts until lifted.
4. The memory tools from Python, through the sidecar, so SDK-only Python agents can write claimed facts to a shared ledger.


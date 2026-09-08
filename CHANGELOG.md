# Changelog

All three packages, `@agent-custody/receipts`, `@agent-custody/state`, and `agent-custody` on PyPI, move in lockstep. The receipt format has stayed at v0.2 throughout; every addition to it is an optional field, so earlier receipts and the published conformance vectors remain valid.

## 0.5.1 — 2026-09-08

- **Receipts:** the operator's admin page. `/admin` on a Postgres-backed log server, behind `--admin-token-env`: tenants listed and created, a token minted and shown once beside the tenant's welcome sheet, tokens revoked, tenants disabled. One inline page, no outside requests. `ADMIN_TOKEN` turns it on in the container.
- **Receipts:** the combined checkpoint store reports the store furthest behind as latest, so a store that missed a write is caught up on the next publication; the image creates `/checkpoints` owned by the log's user.
- **Deploy:** `onboard-tenant.sh` for the shell path; the early-access page says the log is running and taking tenants.
- **Tests:** a thirty-second budget per test in every package; PGlite's engine load is paid in setup.
- **Python:** unchanged; released in step.

## 0.5.0 — 2026-09-08

- **Receipts:** the log over Postgres. `log --db-env` keeps leaves as hashes in one table keyed by tenant, one writer per tenant by advisory lock so a second instance is safe, tenants and sha256-hashed tokens in tables managed by `log-admin`, rate limits per token with a body cap and `retry-after`, retries in the HTTP sink, and `import` for an existing file log. Phase 2 of issue #6.
- **Receipts:** the signer, the key document, and checkpoints. `signer` holds the log's key in its own process and the log signs through `--signer-url`; the log serves `/.well-known/agent-custody-log.json` and `verify --log-url` and `audit --log-url` fetch and pin its keys by keyid; signed checkpoints per log are published to a directory and a table and listed at `/checkpoints`. Phase 3 of issue #6.
- **Deploy:** Postgres and the signer are in the default compose profile, with a checkpoints volume served from a second Caddy host; `--profile file` keeps the single-file server. The image installs `pg`.
- **Python:** unchanged; released in step.

## 0.4.0 — 2026-09-08

- **Receipts:** a log for someone else. `"hashOnly": true` in the `log` config sends only the leaf hash, so a remote log commits to a receipt without ever holding it; the receipts stay with the issuer and the verifier is unchanged. The reference server accepts `{leaf}` or `{leafHash}`, serves several tenant logs at `/t/<tenant>/` from a `--tenants` file with their own tokens and ids, and writes `--log-id` into every tree head. `verify --log-id` and `audit --log-id` check that the tree heads name the expected log. Phase 1 of the hosted log, issue #6.
- **Deploy:** the log server as a container, `ghcr.io/ch4r10t33r/agent-custody-log`, built for amd64 and arm64 by a workflow on every `v*` tag; a docker compose file for one VM with a Caddy TLS profile; Kubernetes manifests on the same contract; `AGENT_CUSTODY_LOG_ID` and `AGENT_CUSTODY_LOG_TENANTS` in it.
- **Site:** the landing page is a quarter of its former length and says what the default install proves and what it does not; a trust-by-setup table; the hosted log stated as not yet built; certified forget defined by what it reaches; the gateway's bypasses listed.
- **Python:** unchanged; released in step.

## 0.3.0 — 2026-09-08

- **Receipts:** pre-commit authorization for consequential tools. Name them in `precommit` (or `*`) and the gateway signs an authorization statement and appends it to the log before forwarding the call; if the log will not take it the call is withheld, nothing goes upstream, and the receipt records `allow` beside `withheld`. The receipt embeds the committed authorization with its inclusion proof, and the verifier adds five checks that it is the issuer's, names this call, is in the log, and precedes the receipt. Mirrored in the browser verifier; three new conformance vectors; tutorial 16. Evidence now precedes the side effect for the calls where that matters.
- **State:** `agent-custody-memory explain`. From a receipt id: who acted, who authorized it, what was allowed, what the agent saw, what it did, why, the evidence, whether it verifies, what depended on it, and what needs reversal. The first eight come from the receipt alone; the last two from the ledger, and without one they read "unknown". `--out --sign` writes the same as one signed action pack with every downstream receipt inside; `--verify` checks it as a whole.
- **Receipts:** the REST connector. An upstream may be a plain HTTP API described as tools, `{ "rest": { "baseUrl", "headerEnv", "tools": [...] } }`, credentials read from the environment at startup. Scope, policy on the gateway's own lookups, pre-commit, and receipts apply unchanged, and a REST upstream sits beside MCP upstreams behind one grant. Tutorial 17.
- **Receipts:** OpenTelemetry export. `otel` in a gateway or SDK config sends one OTLP/HTTP span per receipt to the collector you already run, trace id equal to the receipt id, after the receipt and never on the evidence path. No OpenTelemetry SDK dependency. Tutorial 18.
- **Site:** the landing page leads with proof of what an agent did, the six steps a call goes through, and the questions every receipt answers.
- **Python:** unchanged; released in step.

## 0.2.0 — 2026-09-07

- **State, breaking:** the ledger is asynchronous. Every method returns a promise, `size` is `count()`, `close()` and `export()` return promises, and `blastRadius` and `buildPack` are awaited. Code written against 0.1.x must add `await`; nothing else changes.
- **State:** the ledger holds no events. Every question is a query to the store: everything about the facts matching a filter, everything that touched one fact, the spaces that exist. SQLite answers each from an index on fact, time, space, subject, predicate, and supersession, and fills those columns on a ledger written by an earlier version the first time it opens it. Closes #8.
- **State:** Postgres as a store, for a ledger shared by several servers in the database you already run. `--ledger postgres://…` with the `pg` package installed, or `new PostgresStore(pool)` in code. Forget is an update followed by `VACUUM FULL`, so the old row image does not stay in the table; `vacuum: false` leaves that to your schedule. Tested against the real engine in-process through PGlite, including that a forgotten value is absent from the database files.
- **State:** `Ledger.get`, `learnedBefore`, `spaces`, and `compact`; sweeps compact once at the end rather than per fact.
- **Site:** the landing page says where the ledger lives.

## 0.1.9 — 2026-09-07

- **State:** the custody pack, `agent-custody-memory pack`: one fact's history with the receipt behind each event, its holds, its blast radius with every downstream receipt, and its forget certificate with what the stores answered, as one signed artefact; `pack --verify` checks the signature, the digest, every receipt inside against the gateway's keys, and that the forget receipt names the fact.
- **State:** removal verification. After a retraction, forget, or sweep the server asks each store's own search whether the value still surfaces, with bounded retries, and records `verified`, `stillIndexed`, `unverified`, or `failed` per store in the result and so in the receipt. Mem0 and Zep verify through their search APIs.
- **State:** the memory server warns at startup when no forget key is set, since a plain digest of a short value is guessable.
- **Site:** a deployment page with the architecture and measured sizing, and this changelog.

## 0.1.8 — 2026-09-07

- **State:** the eval harness as a CLI, `agent-custody-memory eval`, with validated scenario files for a team's own incidents, the naive baseline scored beside the ledger, a non-zero exit on regression for cron, and a signed report a reviewer verifies with `eval --verify`.
- **State:** a storage interface for the ledger. JSONL stays the default and the auditable file; a path ending in `.sqlite` or `.db` selects SQLite, with write-ahead logging, secure delete and a truncating checkpoint on forget so no erased value lingers, and a file several processes can open. `export` writes the JSONL of any ledger.
- **Receipts:** provider-native deliveries. An upstream wrapping Stripe or GitHub attaches the signed webhook or delivery for a call; a verifier with the shared secret checks the HMAC, Stripe's timestamp against the receipt's, and the binding of the delivery to the result, and reports the execution as attested by shared secret. `verify --stripe-secret-env`, `--github-secret-env`; three new conformance vectors; the browser verifier mirrors the check.

## 0.1.7 — 2026-09-07

- **State:** forget digests can be keyed under a secret held outside the ledger (`--forget-key-env`) or omitted (`keepDigest: false`), so an erased value cannot be guessed back from the file. The event records which.
- **State:** retention windows per space in the server (`--retention 'org=P365D,team:*=P90D'`); a sweep with no cutoff uses them; `sweep --via gateway.json` runs retention as a receipted call by the principal in that gateway's grant, for any timer.
- **Receipts:** `prune` replaces log leaves older than a cutoff with their hashes and removes their bundles; every proof still verifies.
- **Receipts:** the Merkle log caches complete subtrees, so appends and proofs are logarithmic; receipt cost is flat at 0.15 ms regardless of log size.
- A test loads every receipts module under plain Node, after a construct plain Node rejects broke process-spawning tests for one commit.

## 0.1.6 — 2026-09-07

- **Receipts:** several upstreams behind one gateway and one grant, each tool owned by exactly one; the receipt names which served the call.
- **State:** value-level quarantine. A write may cite a fact the gateway fetched itself; the value must match and the fact is written as `verified`, the provenance level above `attested`, or the write is refused. `requireVerified` on reads.
- **State:** retention sweeps and legal holds, as events with actor, reason, and receipt; a held fact cannot be forgotten or swept until released.
- **Python:** the memory tools over MCP against the shared memory server. Python 3.10 or later.

## 0.1.5 — 2026-09-07

- **Receipts:** consumed facts. An upstream declares the facts it served; every later gateway receipt in the session carries them, observed.
- **State:** blast radius: from a fact to every later call and derived belief, transitively, with retraction status. `agent-custody-memory blast`.
- **State:** policy over provenance: the gateway looks up the fact a write supersedes or a retraction targets through `memory.get`; optional fact lookups in the gateway.
- **State:** certified forget: the value erased from the ledger and every store, the gateway's receipt as the certificate.
- **State:** the memory server over HTTP with bearer auth; the gateway reaches any running MCP server by URL.
- **Receipts:** attested execution: an upstream signs its result for the receipt; the memory server and the demo upstream sign with `--key`.

## 0.1.4 — 2026-09-07

- **State:** quarantine. Facts carry `claimed` or `attested` provenance; claimed facts are hidden from reads until a gateway-only `memory.confirm` lifts them.
- **State:** the memory-mutation eval harness, with the ledger and a naive overwrite store as reference points.
- **State:** write-through adapters for Mem0 and Zep, tested against the real client packages offline; custody metadata travels with the write, retractions reach the store.

## 0.1.3 — 2026-09-07

- **Receipts:** the log sink: append to a remote log whose key signs the tree heads; the reference log server with bearer auth; consistency proofs and the `audit` command; the sidecar (`serve`) for agents in other languages.
- **State:** the memory server: the ledger as MCP tools behind the gateway, with the source receipt id and the attested actor supplied by the gateway.
- **Receipts:** conformance vectors published with the spec.

## 0.1.2 — 2026-09-06

- **Receipts:** the sidecar, required by the Python client.
- **Python:** `agent-custody` on PyPI: a standard-library client of the sidecar with adapters for LangChain, the OpenAI Agents SDK, and the Claude Agent SDK. Go, Java, and Rust clients as examples.

## 0.1.1 — 2026-09-06

- The root walkthrough, the cross-package example, and the first end-to-end use of both packages from a fresh install.

## 0.1.0 — 2026-09-06

- First publish: `@agent-custody/receipts` (gateway, SDK, log, verifier) and `@agent-custody/state` (the bitemporal fact ledger).

# Changelog

All three packages, `@agent-custody/receipts`, `@agent-custody/state`, and `agent-custody` on PyPI, move in lockstep. The receipt format has stayed at v0.2 throughout; every addition to it is an optional field, so earlier receipts and the published conformance vectors remain valid.

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

# The sidecar

The SDK issuer behind a local HTTP API, so an agent written in any language can decide and record. Same config file, same receipts, same key as the in-process SDK. Everything it records is `claimed`: the sidecar trusts what the agent's process tells it. Bind it to localhost; it is a per-host companion, not a service.

```bash
agent-custody serve --config sdk.json --port 8788 --host 127.0.0.1
```

The config is the [SDK config](./sdk-typescript#the-config-file). Programmatically: `serveSidecar(createSdkIssuer(loadSdkConfig("sdk.json")), { port, host }): Promise<{ url, close() }>`.

## `GET /health`

**Response**

```json
{ "agentId": "support-agent", "keyid": "02798017df8d…", "log": { "kind": "http", "where": "https://log.agent-custody.dev/t/acme/" } }
```

`log.kind` is `file` or `http`.

## `POST /decide`

The configured policy's decision for a call, without recording anything. `null` when the sidecar has no policy.

**Request**, a `ToolEvent`

```json
{ "tool": "stripe.refund", "args": { "customer_id": "cust_123", "amount": 2500 }, "model": "claude-fable-5-1", "session": { "id": "sess_1", "toolUseId": "tu_9" } }
```

`model` and `session` are *optional* and recorded as `claimed`.

**Response**, a `PolicyDecision` or `null`

```json
{ "decision": "deny", "reasons": [], "errors": ["no permit policy matched"], "policyDigest": "0e568d6e63ba…" }
```

`reasons` are the ids of the policies that decided; `errors` are evaluation errors, and any error is a deny.

## `POST /record`

Issues one receipt: signs it, appends its hash to the log, writes `receipts/<id>.json`, tells the exporters. Rejects if the log refuses the leaf; then no bundle is written and the agent knows.

**Request**

```json
{
  "event": { "tool": "stripe.refund", "args": { "customer_id": "cust_123", "amount": 2500 } },
  "outcome": { "status": "executed", "result": { "refund_id": "re_1", "status": "succeeded" } },
  "policy": { "decision": "allow", "reasons": ["policy0"], "errors": [], "policyDigest": "0e56…" }
}
```

`outcome` is one of:

| outcome | when |
| --- | --- |
| `{ "status": "executed", "result": <anything> }` | the tool ran and answered |
| `{ "status": "failed", "result": <anything> }` | the tool ran and reported failure |
| `{ "status": "denied", "reason": "…" }` | the policy said no and the tool was not called |
| `{ "status": "error", "error": "…" }` | the tool threw |

`policy` is *optional*: what `/decide` returned, so the receipt carries the decision; `null` when there was no policy.

**Response**, the `ReceiptBundle` as written to disk, `200`

```json
{ "envelope": { "payloadType": "application/vnd.in-toto+json", "payload": "…", "signatures": [{ "keyid": "0279…", "sig": "…" }] }, "treeHead": { "…": "" }, "inclusion": { "leafIndex": 6, "treeSize": 7, "hashes": ["…"] } }
```

The receipt id is inside the statement; every client exposes it (`receipt_id_of(bundle)` in Python). The predicate's `issuer.kind` is `sdk`, `principal.provenance` is `claimed`, and there is no `delegation`.

**Errors**: `400 { "error": "…" }` for a malformed event or outcome; `502 { "error": "log … refused the append: …" }` when the log would not take the leaf; `404` for any other path.

## Clients

- Python: [`agent_custody.Client`](./python#client).
- Go, Java, Rust, or anything with HTTP: the three calls above are the whole protocol. The repository's `examples/languages/` has one complete client per language, each checked by the test suite.

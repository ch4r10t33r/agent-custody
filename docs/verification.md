# Verifying a receipt

A verifier needs three things and no network access:

1. the receipt bundle, one JSON file
2. the gateway's public key
3. the principal's public key

A fourth is optional: a copy of the gateway's log file, which lets the verifier confirm the receipt sits in a log whose root the verifier recomputed, not one the gateway merely asserted.

## From the command line

```bash
node src/cli.ts verify receipts/<id>.json \
  --gateway-key keys/gateway.pub \
  --principal-key keys/principal.pub \
  --log log.jsonl          # optional
```

Exit code 0 when every check passes, 1 otherwise. Add `--json` for machine-readable output. Both `--gateway-key` and `--principal-key` can be repeated to accept rotated keys; signatures are matched by keyid.

A real report, produced by `npm run demo`:

```
PASS  receipt signature (gateway key)  (keyid aa49ff610750)
PASS  receipt payload type
PASS  gateway keyid matches signer
PASS  delegation signature (principal key)  (signed by b4d3da93c781)
PASS  delegation binds principal and agent
PASS  delegation valid at receipt time  (2026-09-04T06:41:51.985Z .. 2026-09-04T07:41:52.985Z)
PASS  executed tool within delegated scope  (stripe.refund)
PASS  request args digest
PASS  policy decision consistent with execution  (allow -> executed)
PASS  no policy errors on an allow
PASS  tree head signature
PASS  tree head matches inclusion proof size
PASS  log inclusion proof  (leaf 0 of 1, root e80b69c92bff)
PASS  log file root matches tree head  (recomputed e80b69c92bff)

RESULT: VERIFIED

field           provenance  value
principal       attested    user_456
agent           attested    support-agent
model           claimed     claude-fable-5-1
tool            observed    stripe.refund
args            claimed     {"amount":50000,"customer_id":"cust_123"}
fact.customer   observed    {"email":"alex@example.com","id":"cust_123","verified":true}
policy          observed    allow [policy1] policy ba4e4461ffc4
execution       observed    executed
```

## What each check means

| check | what it establishes | what a failure usually means |
| --- | --- | --- |
| receipt signature (gateway key) | the bundle's envelope was signed by a key you trust as a gateway key and has not changed since | edited receipt, or a gateway key you do not trust |
| receipt payload type | the payload is an in-toto Statement with this project's predicate type | wrong file, or a different envelope replayed as a receipt |
| gateway keyid matches signer | the receipt's own claim of who signed it matches the actual signature | mixed-up or forged predicate |
| delegation signature (principal key) | the embedded grant was signed by a key you trust as a principal | a grant the principal never issued |
| delegation binds principal and agent | the grant names the same principal and agent the receipt names, and the principal keyid matches | a valid grant for someone else, spliced in |
| delegation valid at receipt time | the receipt's timestamp is inside the grant's window | expired or not-yet-valid authority |
| executed tool within delegated scope | if the tool ran, the grant covered it. Denied calls pass this check by construction | a gateway that forwarded out of scope |
| request args digest | the args in the predicate hash to the digest in the subject | edited arguments |
| policy decision consistent with execution | allow went with executed or failed; deny went with denied | a gateway that executed after a deny |
| no policy errors on an allow | an allow was not produced while Cedar reported errors | broken fail-closed behaviour |
| tree head signature | the tree head was signed by a trusted gateway key | forged log position |
| tree head matches inclusion proof size | the proof and the tree head describe the same tree | mismatched bundle parts |
| log inclusion proof | this exact envelope is a leaf of the tree with that root | receipt never logged, or logged then changed |
| log file root matches tree head | recomputing the root from your copy of the log at that size gives the same value | your log copy and the gateway's history diverge: deletion, reordering, or edit |

## What a verified receipt lets you conclude

Read the provenance column at the bottom of the report. For the executed refund above, a verified receipt supports exactly this statement:

> The gateway holding key `aa49…` observed that the agent `support-agent`, acting under a grant signed by the holder of principal key `b4d3…` for `user_456`, requested `stripe.refund` with these arguments; the gateway itself looked up the customer and got `verified: true`; policy with digest `ba4e…` allowed it; the upstream server returned a result with this digest; and the gateway committed all of that to position 0 of a log whose root is `e80b…`.

It does **not** support:

- that Stripe really executed the refund. The upstream result is `observed`, not signed by Stripe. That is the first roadmap item.
- that the arguments were correct. They are `claimed`: they are what the agent asked for, which is what a receipt should record.
- that the model named in `model` produced the call. No hosted provider signs model identity.
- that the gateway operator is honest. The operator holds the gateway key. Against a dishonest operator you need a log copy taken out of their control, or a signer they do not control. See the threat model table in the README.

## Programmatic verification

```ts
import { readFileSync } from "node:fs";
import { loadPublicKey } from "../src/crypto.ts";
import { verifyBundle, formatReport } from "../src/verify.ts";

const bundle = JSON.parse(readFileSync("receipts/<id>.json", "utf8"));
const result = verifyBundle(bundle, {
  gatewayKeys: [loadPublicKey("keys/gateway.pub")],
  principalKeys: [loadPublicKey("keys/principal.pub")],
  logFile: "log.jsonl",           // optional
});

result.ok                          // every check passed
result.checks                      // [{ name, ok, detail? }]
result.statement?.predicate        // the decoded receipt, only when the signature verified
console.log(formatReport(result));
```

`verifyBundle` is pure and synchronous. It reads the log file only when `logFile` is given.

## Verifying without this codebase

The formats are standard on purpose, so a verifier in another language needs no code from here:

- **Envelope:** [DSSE](https://github.com/secure-systems-lab/dsse). Signature is Ed25519 over `"DSSEv1 " + len(payloadType) + " " + payloadType + " " + len(payload) + " " + payload`.
- **Payload:** [in-toto Statement v1](https://github.com/in-toto/attestation), canonical JSON with sorted keys and no whitespace.
- **keyid:** sha256 of the SPKI DER encoding of the public key, hex.
- **Log:** RFC 6962 hashing (`0x00` prefix for leaves, `0x01` for nodes) and the RFC 9162 inclusion-proof algorithm. Leaves are the canonical JSON of the envelope. The log file is one JSON string per line.

## Auditing a log copy

Take copies of `log.jsonl` on a schedule and keep them where the operator cannot write. Then for any receipt:

```bash
node src/cli.ts verify receipts/<id>.json --gateway-key ... --principal-key ... --log /audit/copies/log-2026-09-04.jsonl
```

The last check recomputes the root at the receipt's tree size from your copy. If the operator later deletes, reorders, or edits a line before that position, the recomputed root changes and the check fails.

Today a copy must be at least as long as the receipt's tree size. Consistency proofs between two tree heads, which would let you check that a newer log extends an older copy without holding the whole file, are on the roadmap.

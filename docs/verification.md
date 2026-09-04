# Verifying a receipt

A verifier needs three things and no network access:

1. the receipt bundle, one JSON file
2. the issuer's public key: the gateway key, or the application key for SDK receipts
3. the principal's public key, for gateway receipts, which carry a signed delegation

A fourth is optional: a copy of the issuer's log file, which lets the verifier confirm the receipt sits in a log whose root the verifier recomputed, not one the issuer merely asserted.

## From the command line

```bash
node src/cli.ts verify receipts/<id>.json \
  --issuer-key keys/gateway.pub \
  --principal-key keys/principal.pub \
  --log log.jsonl          # optional
```

Exit code 0 when every check passes, 1 otherwise. Add `--json` for machine-readable output. `--issuer-key` and `--principal-key` can be repeated to accept rotated keys; signatures are matched by keyid. `--gateway-key` is an alias for `--issuer-key`. `--principal-key` may be omitted for SDK receipts, which carry no delegation.

A real report, produced by `npm run demo`:

```
PASS  receipt signature (issuer key)  (keyid f2f53b689a84)
PASS  receipt payload type
PASS  issuer kind is known  (gateway)
PASS  issuer keyid matches signer
PASS  gateway receipt carries a delegation
PASS  gateway receipt carries a policy decision
PASS  delegation signature (principal key)  (signed by bfa1a505f55b)
PASS  delegation binds principal and agent
PASS  delegation valid at receipt time  (2026-09-04T13:06:20.074Z .. 2026-09-04T14:06:21.074Z)
PASS  executed tool within delegated scope  (stripe.refund)
PASS  request args digest
PASS  policy decision consistent with execution  (allow -> executed)
PASS  no policy errors on an allow
PASS  tree head signature
PASS  tree head matches inclusion proof size
PASS  log inclusion proof  (leaf 0 of 1, root 4efaea879930)
PASS  log file root matches tree head  (recomputed 4efaea879930)

RESULT: VERIFIED

ISSUER: gateway, enforced outside the agent's process; the agent could neither skip nor forge this receipt

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
| receipt signature (issuer key) | the bundle's envelope was signed by a key you trust as an issuer and has not changed since | edited receipt, or an issuer key you do not trust |
| receipt payload type | the payload is an in-toto Statement with this project's predicate type | wrong file, or a different envelope replayed as a receipt |
| issuer kind is known | the receipt says whether a gateway or an SDK produced it; the detail shows which, and the framework | a predicate this verifier does not understand |
| issuer keyid matches signer | the receipt's own claim of who signed it matches the actual signature | mixed-up or forged predicate |
| gateway receipt carries a delegation | gateway receipts always embed the signed grant they enforced | an SDK receipt relabelled as gateway |
| gateway receipt carries a policy decision | gateway receipts always record the Cedar decision | same |
| delegation signature (principal key) | the embedded grant was signed by a key you trust as a principal | a grant the principal never issued |
| delegation binds principal and agent | the grant names the same principal and agent the receipt names, and the principal keyid matches | a valid grant for someone else, spliced in |
| delegation valid at receipt time | the receipt's timestamp is inside the grant's window | expired or not-yet-valid authority |
| executed tool within delegated scope | if the tool ran, the grant covered it. Denied calls pass this check by construction | a gateway that forwarded out of scope |
| principal is claimed, not attested | SDK receipts only: there is no delegation, so the principal is a config string and is labelled as such | an SDK receipt pretending to an attested principal |
| request args digest | the args in the predicate hash to the digest in the subject | edited arguments |
| policy decision consistent with execution | allow went with executed or failed; deny went with denied. Skipped when no policy was evaluated | an issuer that executed after a deny |
| no policy errors on an allow | an allow was not produced while Cedar reported errors | broken fail-closed behaviour |
| tree head signature | the tree head was signed by a trusted issuer key | forged log position |
| tree head matches inclusion proof size | the proof and the tree head describe the same tree | mismatched bundle parts |
| log inclusion proof | this exact envelope is a leaf of the tree with that root | receipt never logged, or logged then changed |
| log file root matches tree head | recomputing the root from your copy of the log at that size gives the same value | your log copy and the issuer's history diverge: deletion, reordering, or edit |

Gateway receipts run seventeen checks, eighteen with a log file. SDK receipts run fewer, because there is no delegation to check, and the report says so on the `principal is claimed` line.

## What a verified receipt lets you conclude

Read the `ISSUER` line first, then the provenance column. For the executed refund above, a gateway receipt, a verified result supports exactly this statement:

> The gateway holding key `f2f5…` observed that the agent `support-agent`, acting under a grant signed by the holder of principal key `bfa1…` for `user_456`, requested `stripe.refund` with these arguments; the gateway itself looked up the customer and got `verified: true`; policy with digest `ba4e…` allowed it; the upstream server returned a result with this digest; and the gateway committed all of that to position 0 of a log whose root is `4efa…`.

For an SDK receipt the statement is shorter: a process holding the application key reported this call, with these arguments and this result, and the record has not changed since. Nothing in it was checked outside that process. The report prints this under `ISSUER` so nobody has to remember it.

A gateway receipt does **not** support:

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
  issuerKeys: [loadPublicKey("keys/gateway.pub")],   // gateway keys and SDK application keys
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
node src/cli.ts verify receipts/<id>.json --issuer-key ... --principal-key ... --log /audit/copies/log-2026-09-04.jsonl
```

The last check recomputes the root at the receipt's tree size from your copy. If the operator later deletes, reorders, or edits a line before that position, the recomputed root changes and the check fails.

Today a copy must be at least as long as the receipt's tree size. Consistency proofs between two tree heads, which would let you check that a newer log extends an older copy without holding the whole file, are on the roadmap.

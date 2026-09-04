# agent-receipts

Signed, independently verifiable receipts for AI agent tool calls.

An MCP gateway sits between an agent and the systems it can affect. For every tool call, allowed or denied, it:

1. checks the call against a **delegation grant** signed by the human principal,
2. gathers the facts the policy needs by calling upstream itself, never trusting the agent's word,
3. evaluates a **Cedar** policy, failing closed on any error,
4. forwards the call upstream only on allow,
5. emits an **in-toto statement**, signs it in a **DSSE** envelope, and appends it to a **Merkle transparency log** (RFC 6962 hashing, RFC 9162 proofs),
6. writes a self-contained receipt bundle that anyone holding the public keys can verify offline.

The agent is not trusted. The layer around it is, and the receipt says exactly how far that trust extends.

## Quick start

```bash
bun install        # or pnpm / npm once your npm works
npm run demo       # keys, grant, policy, four tool calls, verification, a tampering attempt
npm test
```

The demo leaves everything in `demo-out/`. Verify a receipt by hand:

```bash
npx tsx src/cli.ts verify demo-out/receipts/<id>.json \
  --gateway-key demo-out/keys/gateway.pub \
  --principal-key demo-out/keys/principal.pub \
  --log demo-out/log.jsonl
```

Exit code 0 means every check passed. The report lists each check, then each field with its provenance.

## What a receipt proves, and what it does not

Every field in a receipt carries one of three provenance labels. This is the design decision that matters most.

| provenance | meaning | today's examples |
| --- | --- | --- |
| `attested` | signed by a key other than the gateway's | principal id, agent id, the delegation grant |
| `observed` | the gateway obtained it deterministically itself | upstream tool results, fact lookups, the policy decision, execution status |
| `claimed` | originated from the agent or model, no independent check | tool arguments, the model id |

The threat model, per claim:

| claim | verifier | adversary | mechanism | status |
| --- | --- | --- | --- | --- |
| receipt was not altered after issue | anyone | later editor | DSSE signature over canonical JSON | done |
| receipt was issued in sequence, none removed | auditor with a log copy | operator rewriting history | Merkle inclusion proof + recomputed root | done |
| the principal really delegated this scope to this agent | anyone with the principal's key | operator, agent | grant signed by principal key, checked for scope and validity window | done |
| the policy decision was made against this exact policy | anyone | operator swapping policies | sha256 of policy text in the receipt | done |
| facts the policy relied on were not asserted by the agent | anyone reading the receipt | agent | facts fetched by the gateway, recorded with their own digests, labelled `observed` | done |
| the upstream system actually executed the action | third party | operator | needs the upstream's own signed response embedded verbatim | **not done**, depends on the tool provider |
| the operator itself cannot mint a false receipt | regulator, counterparty | operator | needs a TEE-hosted signer or a federated log | **not done** |
| which model produced the call | anyone | operator | no hosted provider signs model identity | **not possible today**, labelled `claimed` |

If a vendor tells you their receipts prove more than the first five rows, ask them which key signed it.

## Layout

```
src/crypto.ts      canonical JSON, sha256, Ed25519 keys, DSSE sign/verify
src/log.ts         Merkle log: append, root, inclusion proof, verify, JSONL persistence
src/policy.ts      Cedar evaluation wrapper, fail-closed
src/delegation.ts  signed delegation grants
src/receipt.ts     receipt statement types and provenance labels
src/gateway.ts     the MCP proxy: scope check, facts, policy, forward, receipt
src/verify.ts      offline verification and the human-readable report
src/cli.ts         keygen, grant, gateway, verify
scripts/           fake Stripe upstream, fixture builder, demo
test/              unit tests per module and an end-to-end gateway test
```

## Configuration

```json
{
  "identity": { "keyFile": "keys/gateway.key" },
  "upstream": { "command": "node", "args": ["my-mcp-server.js"] },
  "grantFile": "grant.json",
  "trustedPrincipalKeys": ["keys/principal.pub"],
  "policyFile": "policy.cedar",
  "facts": [
    { "name": "customer", "tool": "customer.lookup", "args": { "customer_id": "$args.customer_id" }, "forTools": ["stripe.refund"] }
  ],
  "receiptsDir": "receipts",
  "logFile": "log.jsonl"
}
```

Paths resolve relative to the config file. `facts` entries tell the gateway which upstream tool to call before evaluating policy for a given tool, and appear in Cedar as `context.facts.<name>`. Cedar sees `context.args` (claimed), `context.facts` (observed), and `context.grant` (attested).

Cedar has no floats. Pass money as integer minor units.

## Roadmap, in the order it pays off

1. Embed upstream signed responses (Stripe webhook signatures, GitHub delivery signatures) so execution can move from `observed` to `attested`.
2. OpenTelemetry span ids on receipts so existing observability links to them.
3. Delegation chains for sub-agents.
4. Receiver-attested receipts for agent-to-agent calls.
5. A TEE-hosted signer, then SD-JWT redaction, then ZK proofs of policy compliance. Not before.

# The TypeScript SDK

The receipt issuer inside the agent's own process, for tools that are plain functions rather than MCP servers. Every field it records is `claimed`: the SDK is the agent's own report, not evidence against the agent. Use it to record everything; use the [gateway](./gateway) to enforce the calls that matter.

```ts
import { createSdkIssuer, loadSdkConfig } from "@agent-custody/receipts";
const issuer = createSdkIssuer(loadSdkConfig("sdk.json"));
```

## The config file

`sdk.json`, paths relative to the file.

```json
{
  "agentId": "support-agent",
  "principalId": "user_456",
  "identity": { "keyFile": "keys/app.key" },
  "policyFile": "policy.cedar",
  "receiptsDir": "receipts",
  "log": { "url": "https://log.agent-custody.dev/t/acme/", "tokenEnv": "AGENT_CUSTODY_LOG_TOKEN", "hashOnly": true },
  "framework": "openai-agents",
  "otel": { "url": "http://localhost:4318" }
}
```

| field | meaning |
| --- | --- |
| `agentId` | recorded on every receipt as the agent, `claimed` |
| `principalId` | *optional*, recorded as the principal, `claimed` |
| `identity.keyFile` | the application's Ed25519 key; signs receipts |
| `policyFile` | *optional* Cedar policy; with it, `decide` and `wrap` can deny |
| `receiptsDir` | where bundles are written |
| `logFile` or `log` | exactly one: a local Merkle log, or a remote one as in the [gateway config](./gateway#the-config-file) |
| `framework` | *optional* free-text label, recorded on `issuer.framework` |
| `otel`, `splunk` | *optional* [exporters](./gateway#exporters) |

## `SdkIssuer`

```ts
interface SdkIssuer {
  agentId: string;
  keyid: string;
  log: LogSink;                                             // { kind: "file" | "http", where, append(leaf) }
  decide(ev: ToolEvent): PolicyDecision | null;
  record(ev: ToolEvent, outcome: Outcome, policy?: PolicyDecision | null): Promise<ReceiptBundle>;
  wrap<A, R>(tool: string, fn: (args: A) => R | Promise<R>, meta?: { model?, session? }): (args: A) => Promise<R>;
}
interface ToolEvent { tool: string; args: Record<string, unknown>; model?: string | null; session?: { id?: string | null; toolUseId?: string | null } }
type Outcome = { status: "executed" | "failed"; result: unknown } | { status: "denied"; reason: string } | { status: "error"; error: string };
interface PolicyDecision { decision: "allow" | "deny"; reasons: string[]; errors: string[]; policyDigest: string }
```

### `decide(event)`

Evaluates the policy for a call, records nothing. `null` when no policy is configured.

```ts
issuer.decide({ tool: "stripe.refund", args: { customer_id: "cust_123", amount: 5_000_000 } });
// → { decision: "deny", reasons: [], errors: [], policyDigest: "0e56…" }
```

Over the SDK the Cedar context has `args` and `grant: { principal, scopes: [] }` and no `facts`; there is no gateway to fetch any.

### `record(event, outcome, policy?)`

Issues one receipt: signs it, appends its hash to the log, writes `receipts/<id>.json`, tells the exporters. Rejects if the log refuses; then no bundle is written.

```ts
const bundle = await issuer.record({ tool: "crm.lookup", args: { id: 1 } }, { status: "executed", result: { plan: "pro" } }, issuer.decide(ev));
bundle.inclusion.leafIndex;                                    // 0
receiptIdOf(bundle);                                           // "c92e582b-…"
```

The bundle is the same [receipt bundle](./gateway#the-receipt-bundle) the gateway writes, with `issuer.kind: "sdk"`, `principal.provenance: "claimed"`, and no `delegation`.

### `wrap(tool, fn, meta?)`

Decide, run, record. Throws `PolicyDeniedError` (`.tool`, `.reason`, `.receiptId`) on deny, after issuing the denial receipt; a thrown `fn` is recorded as `error` and re-thrown.

```ts
const refund = issuer.wrap("stripe.refund", async (args: { customer_id: string; amount: number }) => stripe.refunds.create(args));
await refund({ customer_id: "cust_123", amount: 2500 });     // executed, recorded
```

## Adapters

Each records the framework's tool calls through the issuer. Enforce or observe, never both on one tool.

| import | function | what it does |
| --- | --- | --- |
| `@agent-custody/receipts/sdk/vercel-ai` | `wrapTools(issuer, tools)` | returns the same tool map with each `execute` wrapped: decide, run, record; a denial returns the denial text as the tool result |
| `@agent-custody/receipts/sdk/openai-agents` | `wrapTools(issuer, tools)` | the same for OpenAI Agents SDK function tools (`invoke` wrapped) |
| `@agent-custody/receipts/sdk/openai-agents` | `observeRunner(issuer, runner)` | record-only: listens to a runner's tool events; evaluates no policy |
| `@agent-custody/receipts/sdk/langchain` | `receiptCallbacks(issuer)` → `{ callbacks }` | record-only callback handler for LangChain and LangGraph; pass it in the run config |
| `@agent-custody/receipts/sdk/claude` | `handleHookEvent(issuer, input)` | Claude Code and Claude Agent SDK hooks; see [Claude Code](./claude-code) |
| `@agent-custody/receipts/sdk/claude` | `claudeAgentHooks(issuer, matcher?)` | the in-process hooks object for the Claude Agent SDK, built on `handleHookEvent` |

## The log client

`httpLog(url, { token?, hashOnly?, retries? = 3, timeoutMs? = 10000, fetch? })` is what the gateway and SDK use for a remote log: `POST <url>append` with `{ leaf }` or `{ leafHash }`, retrying 429 and 5xx with backoff and honouring `Retry-After`. `fileLog(path, key)` is the local one. Both are `LogSink`s: `append(leaf): Promise<{ inclusion, treeHead }>`. `openLog(config, key)` picks from a config.

## Verifying in code

```ts
import { verifyBundle, formatReport, loadPublicKey } from "@agent-custody/receipts";
const r = verifyBundle(bundle, { issuerKeys: [loadPublicKey("keys/app.pub")], principalKeys: [] });
r.ok; r.checks;                                                // [{ name, ok, detail? }]
console.log(formatReport(r));
```

Every option and check is on the [verify](./verify) page.

## Keys

`generateKeyPair(): KeyPair`, `writeKeyPair(kp, dir, name)` → `{ keyFile, pubFile }`, `loadPrivateKey(path)`, `loadPublicKey(path): PublicKeyRef` (`{ publicKey, keyid }`), `publicKeyFromPem(pem)`, `publicKeyToPem(publicKey)`. Keys are Ed25519; a keyid is the SHA-256 of the SPKI DER. `dsseSign(payloadType, payload, keyPair): Envelope` and `dsseVerify(envelope, trustedKeys)` are the primitives every signed artefact uses.

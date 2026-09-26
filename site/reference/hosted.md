# The hosted log

The log at `log.agent-custody.dev` is the reference log server run by us, for teams whose receipts need a signer that is not their own operator. It holds leaf hashes, never receipts. Everything on this page also applies to a log you run yourself from [deploy/](https://github.com/ch4r10t33r/agent-custody/tree/main/deploy).

## Plans

| plan | appends a calendar month | price |
| --- | --- | --- |
| `free` | 10,000 | $0 |
| `team` | 1,000,000 | $50 a month |
| `enterprise` | no allowance | by conversation |

An append past the allowance is refused:

```
HTTP 429
Retry-After: <seconds to the start of next month>
{ "error": "monthly quota reached: 10000 of 10000 appends on the free plan; it resets at the start of next month, or move to a larger plan" }
```

The gateway's log client retries a 429 three times with backoff and then fails the call: a pre-committed call is withheld, any other returns an error to the agent. Nothing acts without evidence. See [pricing](https://agent-custody.dev/pricing).

## Registering: the portal

`https://app.agent-custody.dev/` is one page. Registering creates the account, the tenant, and its first key, shown once. The page's own API, which any HTTP client may use with the session cookie it sets:

| route | body | response |
| --- | --- | --- |
| `POST /api/register` | `{ "email", "password" (10+ chars), "tenant" (3–40 chars, `[a-z0-9-]`) }` | `{ "tenant", "logId", "plan": "free", "token": "<64 hex, shown once>", "tokenHash": "<12 hex>", "welcome": "<the welcome sheet>", "exportCommand": "…" }` and a session cookie; `400` on validation, `409` if the email or tenant is taken, `429` after five registrations from one address |
| `POST /api/login` | `{ "email", "password" }` | `{ "email" }` and the cookie; `401` otherwise; throttled per address |
| `POST /api/logout` | `{}` | `{ "ok": true }` |
| `GET /api/me` | | `{ "email", "tenant", "logId", "plan", "used", "quota", "disabled", "billing": true\|false }` |
| `GET /api/overview` | | `{ "tenant", "logId", "plan", "used", "quota", "treeSize", "rootHash", "latestCheckpoint": { "treeSize", "signedAt" } \| null, "months": [{ "month": "2026-09", "appends": 37 }, …6], "keys": [{ "label", "hash", "createdAt", "revokedAt" }], "audit": [{ "id", "at", "actor", "action", "tenantId", "detail" }], "billing": { "status" } \| null, "urls": { "log", "keys", "checkpoints" }, "exportCommand", "welcome", "stripe": true\|false }` |
| `GET /api/keys` | | `{ "keys": [...] }` |
| `POST /api/keys` | `{ "label" }` | `{ "token": "<shown once>", "tokenHash": "<12 hex>", "label" }` |
| `POST /api/keys/<hash prefix>/revoke` | `{}` | `{ "revoked": 1 }` |
| `POST /api/checkout` | `{}` | `{ "url": "https://checkout.stripe.com/…" }`; `409` if not on `free`; `503` when billing is not configured |
| `POST /api/billing-portal` | `{}` | `{ "url": "https://billing.stripe.com/…" }` |
| `POST /stripe/webhook` | Stripe's event, `Stripe-Signature` header | `{ "received": true }`; `400` on a bad or stale signature |
| `GET /health` | | `{ "ok": true, "stripe": true\|false }` |

Every write needs `Content-Type: application/json`; the cookie is `HttpOnly; SameSite=Strict`. Every action is in the tenant's audit trail as `portal:<email>`, and plan changes made by Stripe as `stripe:<event>`.

## Using a tenant

The welcome sheet has the three things a tenant needs; in the gateway or SDK config:

```json
"log": { "url": "https://log.agent-custody.dev/t/acme/", "tokenEnv": "AGENT_CUSTODY_LOG_TOKEN", "hashOnly": true }
```

Verifiers add `--log-url https://log.agent-custody.dev/ --log-id acme`, which fetches and pins the published keys and requires the tree heads to be this tenant's. The tenant's routes are the [log API](./log-api) under `/t/acme/`; `leaves`, `usage`, and `audit` there answer only to the tenant's token.

## Taking your data

```bash
npx @agent-custody/receipts log-export --log-url https://log.agent-custody.dev/ --tenant acme --token-env AGENT_CUSTODY_LOG_TOKEN --out custody-export/
```

Writes `log.jsonl` (every leaf hash, in the format `verify --log` and `audit --log` read offline), `head.json`, `keys.json`, `checkpoints.json`, `usage.json`, `audit.json`, and `export.json`, after checking that the head and every checkpoint verify against the published keys and that the leaves hash to their roots. Exit 1 and `RESULT: EXPORT DOES NOT ADD UP` if anything does not. Details under [verify](./verify#log-export).

## The operator's side

For whoever runs a log: `agent-custody log-admin --db-env DATABASE_URL tenant add|list|disable|plan`, `token add|list|revoke`, `audit`, `import`; the admin page at `/admin` behind the admin token with the same operations, usage per tenant per month, a CSV for invoicing, and the activity list. The [runbook](https://github.com/ch4r10t33r/agent-custody/blob/main/deploy/RUNBOOK.md) is the operating manual.

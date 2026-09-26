// The tenant portal: where a team registers, gets its tenant on the hosted log and its first API key, watches its
// usage against its plan, mints and revokes keys, and pays. One process beside the log, on the same Postgres, with
// its own tables under `portal_`. Everything a tenant can do here they could also do by asking the operator; the
// portal removes the asking. It holds no receipts and never sees a receipt: the numbers it shows are the log's
// counts, the hashes it lists are the same hashes the export carries.
//
// Sessions are a signed cookie, passwords are scrypt, the page is one inline file with no framework and a strict
// content-security policy, and every API write requires a JSON body, which with a SameSite=Strict cookie is what
// keeps a cross-site page from acting as the user. Billing is Stripe Checkout for the team plan; the webhook moves
// the tenant's plan, and nothing about a card ever passes through here.
import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { postgresCheckpoints, type CheckpointStore } from "./checkpoints.ts";
import { welcomeSheet } from "./log-admin.ts";
import { clientAddress } from "./log-sink.ts";
import { PLAN_QUOTAS, RateLimiter, type Plan, type PostgresLike, type PostgresTenancy } from "./log-store.ts";

export interface StripeOptions {
  secretKey: string;
  webhookSecret: string;
  /** the Stripe price id of the team plan's monthly subscription */
  priceTeam: string;
  fetch?: typeof fetch;
}

export interface PortalOptions {
  tenancy: PostgresTenancy;
  /** the Postgres client the tenancy uses; the portal's own tables live beside the log's */
  client: PostgresLike;
  /** signs session cookies; rotate to sign everyone out */
  secret: string;
  /** the log's public base URL, for the welcome sheet and the export command */
  publicUrl: string;
  checkpointsUrl?: string;
  /** the log's current signing keyid, for the sheet */
  keyid?: string;
  /** the portal's own public URL, for Stripe's return addresses */
  portalUrl?: string;
  stripe?: StripeOptions;
  /** key throttles by X-Forwarded-For; only behind a proxy you run. Also marks cookies Secure. */
  trustProxy?: boolean;
  /** table prefix; default portal_ */
  prefix?: string;
  log?: (message: string) => void;
}

export interface PortalUser {
  id: string;
  email: string;
  createdAt: string;
}

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`prefix must be a plain identifier; got "${s}"`);
  return s;
};

/** Users, memberships, and billing records, beside the log's tables. */
export class PortalStore {
  private readonly client: PostgresLike;
  private readonly p: string;
  private ready: Promise<void> | null = null;
  // no parameter properties: the CLI runs on plain Node type stripping
  constructor(client: PostgresLike, prefix = "portal_") {
    this.client = client;
    this.p = ident(prefix);
  }
  private init(): Promise<void> {
    if (!this.ready) {
      const p = this.p;
      this.ready = (async () => {
        await this.client.query(`CREATE TABLE IF NOT EXISTS ${p}users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
        await this.client.query(`CREATE TABLE IF NOT EXISTS ${p}members (user_id TEXT NOT NULL REFERENCES ${p}users(id), tenant_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'owner', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (user_id, tenant_id))`);
        await this.client.query(`CREATE TABLE IF NOT EXISTS ${p}billing (tenant_id TEXT PRIMARY KEY, customer_id TEXT, subscription_id TEXT, status TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      })();
    }
    return this.ready;
  }
  static hashPassword(password: string): string {
    const salt = randomBytes(16);
    return `scrypt$${salt.toString("hex")}$${scryptSync(password, salt, 64).toString("hex")}`;
  }
  static checkPassword(password: string, stored: string): boolean {
    const [alg, saltHex, hashHex] = stored.split("$");
    if (alg !== "scrypt" || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, "hex");
    const got = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
    return got.length === expected.length && timingSafeEqual(got, expected);
  }
  async createUser(email: string, password: string): Promise<PortalUser> {
    await this.init();
    const id = randomUUID();
    const rows = (await this.client.query(`INSERT INTO ${this.p}users (id, email, password_hash) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING RETURNING id, email, created_at`, [id, email, PortalStore.hashPassword(password)])).rows as Record<string, unknown>[];
    if (!rows[0]) throw new Error("an account with this email already exists");
    return { id, email, createdAt: new Date(rows[0].created_at as string).toISOString() };
  }
  async authenticate(email: string, password: string): Promise<PortalUser | null> {
    await this.init();
    const rows = (await this.client.query(`SELECT id, email, password_hash, created_at FROM ${this.p}users WHERE email = $1`, [email])).rows as Record<string, unknown>[];
    const r = rows[0];
    if (!r || !PortalStore.checkPassword(password, String(r.password_hash))) return null;
    return { id: String(r.id), email: String(r.email), createdAt: new Date(r.created_at as string).toISOString() };
  }
  async user(id: string): Promise<PortalUser | null> {
    await this.init();
    const rows = (await this.client.query(`SELECT id, email, created_at FROM ${this.p}users WHERE id = $1`, [id])).rows as Record<string, unknown>[];
    const r = rows[0];
    return r ? { id: String(r.id), email: String(r.email), createdAt: new Date(r.created_at as string).toISOString() } : null;
  }
  async addMember(userId: string, tenantId: string): Promise<void> {
    await this.init();
    await this.client.query(`INSERT INTO ${this.p}members (user_id, tenant_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, tenantId]);
  }
  /** the user's tenant; one per account today */
  async tenantOf(userId: string): Promise<string | null> {
    await this.init();
    const rows = (await this.client.query(`SELECT tenant_id FROM ${this.p}members WHERE user_id = $1 ORDER BY created_at LIMIT 1`, [userId])).rows as { tenant_id: string }[];
    return rows[0]?.tenant_id ?? null;
  }
  async setBilling(tenantId: string, b: { customerId?: string | null; subscriptionId?: string | null; status: string }): Promise<void> {
    await this.init();
    await this.client.query(
      `INSERT INTO ${this.p}billing (tenant_id, customer_id, subscription_id, status, updated_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (tenant_id) DO UPDATE SET customer_id = COALESCE(EXCLUDED.customer_id, ${this.p}billing.customer_id), subscription_id = COALESCE(EXCLUDED.subscription_id, ${this.p}billing.subscription_id), status = EXCLUDED.status, updated_at = now()`,
      [tenantId, b.customerId ?? null, b.subscriptionId ?? null, b.status],
    );
  }
  async billing(tenantId: string): Promise<{ customerId: string | null; subscriptionId: string | null; status: string } | null> {
    await this.init();
    const rows = (await this.client.query(`SELECT customer_id, subscription_id, status FROM ${this.p}billing WHERE tenant_id = $1`, [tenantId])).rows as Record<string, unknown>[];
    const r = rows[0];
    return r ? { customerId: r.customer_id ? String(r.customer_id) : null, subscriptionId: r.subscription_id ? String(r.subscription_id) : null, status: String(r.status) } : null;
  }
  async tenantBySubscription(subscriptionId: string): Promise<string | null> {
    await this.init();
    const rows = (await this.client.query(`SELECT tenant_id FROM ${this.p}billing WHERE subscription_id = $1`, [subscriptionId])).rows as { tenant_id: string }[];
    return rows[0]?.tenant_id ?? null;
  }
}

// ---- sessions ----
const b64u = (b: Buffer) => b.toString("base64url");
export function signSession(secret: string, userId: string, ttlMs = 14 * 86_400_000): string {
  const body = b64u(Buffer.from(JSON.stringify({ u: userId, e: Date.now() + ttlMs })));
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}
export function readSession(secret: string, cookie: string | undefined): string | null {
  if (!cookie) return null;
  const [body, mac] = cookie.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  if (expected.length !== mac.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return null;
  try {
    const { u, e } = JSON.parse(Buffer.from(body, "base64url").toString()) as { u: string; e: number };
    return typeof u === "string" && typeof e === "number" && e > Date.now() ? u : null;
  } catch {
    return null;
  }
}

// ---- Stripe, over its REST API; no SDK ----
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
export async function stripeRequest(s: StripeOptions, path: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const f = s.fetch ?? fetch;
  const res = await f(`https://api.stripe.com/v1/${path}`, { method: "POST", headers: { authorization: `Bearer ${s.secretKey}`, "content-type": "application/x-www-form-urlencoded" }, body: form(body), signal: AbortSignal.timeout(15_000) });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`stripe ${path}: ${(json.error as { message?: string })?.message ?? res.status}`);
  return json;
}
/** Stripe-Signature: t=<unix>,v1=<hmac>; the mac is over `${t}.${rawBody}` with the endpoint secret. */
export function verifyStripeSignature(header: string | undefined, rawBody: string, secret: string, now = Date.now(), toleranceMs = 5 * 60_000): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(now - t * 1000) > toleranceMs) return false;
  const expected = createHmac("sha256", secret).update(`${parts.t}.${rawBody}`).digest("hex");
  return header
    .split(",")
    .filter((kv) => kv.startsWith("v1="))
    .some((kv) => {
      const sig = kv.slice(3);
      return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    });
}

export interface RunningPortal {
  url: string;
  close(): Promise<void>;
}

const TENANT_ID = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESERVED = new Set(["default", "admin", "api", "www", "log", "checkpoints", "app", "portal", "stripe", "health", "t"]);

export function portalHandler(o: PortalOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const store = new PortalStore(o.client, o.prefix);
  const heads: CheckpointStore = postgresCheckpoints(o.client);
  const log = o.log ?? ((m) => console.error(m));
  const loginFailures = new RateLimiter({ perSecond: 1 / 30, burst: 8 });
  const registrations = new RateLimiter({ perSecond: 1 / 600, burst: 5 });
  const base = o.publicUrl.endsWith("/") ? o.publicUrl : `${o.publicUrl}/`;
  const cookieName = "custody_session";

  const sheet = (tenant: string, logId: string) => welcomeSheet({ tenant, logId, publicUrl: base, ...(o.checkpointsUrl ? { checkpointsUrl: o.checkpointsUrl } : {}), ...(o.keyid ? { keyid: o.keyid } : {}) });
  const exportCommand = (tenant: string) => `npx @agent-custody/receipts log-export --log-url ${base} --tenant ${tenant} --token-env AGENT_CUSTODY_LOG_TOKEN --out custody-export/`;

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const addr = clientAddress(req, o.trustProxy);
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
      res.end(JSON.stringify(body));
    };
    const setCookie = (value: string | null) => `${cookieName}=${value ?? ""}; Path=/; HttpOnly; SameSite=Strict${o.trustProxy ? "; Secure" : ""}; Max-Age=${value ? 14 * 86_400 : 0}`;
    const cookies = Object.fromEntries((req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=") as [string, string]).filter(([k]) => k));
    const userId = readSession(o.secret, cookies[cookieName]);
    const rawBody = async (): Promise<string> => {
      let text = "";
      for await (const chunk of req) {
        text += chunk;
        if (text.length > 65_536) throw new Error("body too large");
      }
      return text;
    };
    const jsonBody = async (): Promise<Record<string, unknown>> => {
      if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new Error("expected a JSON body");
      const t = await rawBody();
      return t ? (JSON.parse(t) as Record<string, unknown>) : {};
    };

    try {
      if (req.method === "GET" && url.pathname === "/health") return json(200, { ok: true, stripe: !!o.stripe });
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'" });
        return void res.end(PORTAL_PAGE);
      }

      // ---- Stripe's webhook: the only caller that is not a browser with a session ----
      if (req.method === "POST" && url.pathname === "/stripe/webhook") {
        if (!o.stripe) return json(503, { error: "billing is not configured" });
        const raw = await rawBody();
        if (!verifyStripeSignature(req.headers["stripe-signature"] as string | undefined, raw, o.stripe.webhookSecret)) return json(400, { error: "bad signature" });
        const event = JSON.parse(raw) as { type: string; data: { object: Record<string, unknown> } };
        const obj = event.data.object;
        if (event.type === "checkout.session.completed") {
          const tenant = String(obj.client_reference_id ?? "");
          if (tenant && (await o.tenancy.tenant(tenant))) {
            await store.setBilling(tenant, { customerId: obj.customer ? String(obj.customer) : null, subscriptionId: obj.subscription ? String(obj.subscription) : null, status: "active" });
            await o.tenancy.setPlan(tenant, "team", "stripe:checkout");
            log(`agent-custody portal: tenant ${tenant} moved to team by checkout ${String(obj.id ?? "")}`);
          }
        } else if (event.type === "customer.subscription.deleted" || event.type === "customer.subscription.updated") {
          const tenant = await store.tenantBySubscription(String(obj.id ?? ""));
          if (tenant) {
            const status = event.type === "customer.subscription.deleted" ? "canceled" : String(obj.status ?? "unknown");
            await store.setBilling(tenant, { status });
            const plan: Plan = status === "active" || status === "trialing" || status === "past_due" ? "team" : "free";
            const current = (await o.tenancy.tenant(tenant))?.plan;
            if (current !== "enterprise" && current !== plan) await o.tenancy.setPlan(tenant, plan, `stripe:${event.type}`);
          }
        }
        return json(200, { received: true });
      }

      // ---- registration and login ----
      if (req.method === "POST" && url.pathname === "/api/register") {
        if (!registrations.take(`reg:${addr}`)) return json(429, { error: "too many registrations from this address; try again later" });
        const b = await jsonBody();
        const email = String(b.email ?? "").trim().toLowerCase();
        const password = String(b.password ?? "");
        const tenant = String(b.tenant ?? "").trim().toLowerCase();
        if (!EMAIL.test(email)) return json(400, { error: "a valid email address is needed" });
        if (password.length < 10) return json(400, { error: "the password needs at least ten characters" });
        if (!TENANT_ID.test(tenant) || RESERVED.has(tenant)) return json(400, { error: "the tenant id is the name in your log's URL: three to forty lowercase letters, digits, or hyphens, and not a reserved word" });
        if (await o.tenancy.tenant(tenant)) return json(409, { error: "that tenant id is taken" });
        let user: PortalUser;
        try {
          user = await store.createUser(email, password);
        } catch (e) {
          return json(409, { error: e instanceof Error ? e.message : String(e) });
        }
        const t = await o.tenancy.addTenant(tenant, tenant, `portal:${email}`);
        await store.addMember(user.id, tenant);
        const minted = await o.tenancy.addToken(tenant, "first key", `portal:${email}`);
        log(`agent-custody portal: ${email} registered tenant ${tenant}`);
        return json(200, { tenant: t.id, logId: t.logId, plan: t.plan, token: minted.token, tokenHash: minted.tokenHash.slice(0, 12), welcome: sheet(t.id, t.logId), exportCommand: exportCommand(t.id) }, { "set-cookie": setCookie(signSession(o.secret, user.id)) });
      }
      if (req.method === "POST" && url.pathname === "/api/login") {
        if (!loginFailures.take(`login:${addr}`)) return json(429, { error: "too many attempts; wait a minute" });
        const b = await jsonBody();
        const user = await store.authenticate(String(b.email ?? "").trim().toLowerCase(), String(b.password ?? ""));
        if (!user) return json(401, { error: "email or password not recognised" });
        return json(200, { email: user.email }, { "set-cookie": setCookie(signSession(o.secret, user.id)) });
      }
      if (req.method === "POST" && url.pathname === "/api/logout") return json(200, { ok: true }, { "set-cookie": setCookie(null) });

      // ---- everything below needs a session ----
      if (!url.pathname.startsWith("/api/")) return json(404, { error: "not found" });
      const user = userId ? await store.user(userId) : null;
      if (!user) return json(401, { error: "sign in first" });
      const tenantId = await store.tenantOf(user.id);
      if (!tenantId) return json(409, { error: "this account has no tenant" });
      const tenant = await o.tenancy.tenant(tenantId);
      if (!tenant) return json(409, { error: "the tenant no longer exists" });
      if (req.method !== "GET" && !(req.headers["content-type"] ?? "").startsWith("application/json")) return json(415, { error: "expected a JSON body" });

      if (req.method === "GET" && url.pathname === "/api/me") {
        const q = await o.tenancy.quota(tenantId);
        return json(200, { email: user.email, tenant: tenantId, logId: tenant.logId, plan: q.plan, used: q.used, quota: q.quota, disabled: !!tenant.disabledAt, billing: !!o.stripe });
      }
      if (req.method === "GET" && url.pathname === "/api/overview") {
        const q = await o.tenancy.quota(tenantId);
        const backend = await o.tenancy.log(tenantId);
        const size = await backend.size();
        const latest = await heads.latest(tenantId);
        const months: { month: string; appends: number }[] = [];
        for (let i = 5; i >= 0; i--) {
          const d = new Date();
          const month = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7);
          const u = await o.tenancy.usage(month);
          months.push({ month, appends: u.tenants.find((t) => t.id === tenantId)?.appends ?? 0 });
        }
        const keys = (await o.tenancy.listTokens(tenantId)).map((k) => ({ label: k.label, hash: k.tokenHash.slice(0, 12), createdAt: k.createdAt, revokedAt: k.revokedAt }));
        const audit = await o.tenancy.audit({ tenant: tenantId, limit: 50 });
        const billing = await store.billing(tenantId);
        return json(200, { tenant: tenantId, logId: tenant.logId, plan: q.plan, used: q.used, quota: q.quota, treeSize: size, rootHash: size ? await backend.root(size) : null, latestCheckpoint: latest ? { treeSize: latest.treeSize, signedAt: latest.signedAt } : null, months, keys, audit, billing: billing ? { status: billing.status } : null, urls: { log: `${base}t/${tenantId}/`, keys: `${base}.well-known/agent-custody-log.json`, checkpoints: o.checkpointsUrl ? `${o.checkpointsUrl.replace(/\/?$/, "/")}${tenantId}/latest.json` : null }, exportCommand: exportCommand(tenantId), welcome: sheet(tenantId, tenant.logId), stripe: !!o.stripe });
      }
      if (req.method === "GET" && url.pathname === "/api/keys") {
        return json(200, { keys: (await o.tenancy.listTokens(tenantId)).map((k) => ({ label: k.label, hash: k.tokenHash.slice(0, 12), createdAt: k.createdAt, revokedAt: k.revokedAt })) });
      }
      if (req.method === "POST" && url.pathname === "/api/keys") {
        const b = await jsonBody();
        const label = String(b.label ?? "").trim().slice(0, 64) || "key";
        const minted = await o.tenancy.addToken(tenantId, label, `portal:${user.email}`);
        return json(200, { token: minted.token, tokenHash: minted.tokenHash.slice(0, 12), label });
      }
      const revoke = /^\/api\/keys\/([0-9a-f]{8,64})\/revoke$/.exec(url.pathname);
      if (req.method === "POST" && revoke) {
        await jsonBody();
        return json(200, { revoked: await o.tenancy.revokeToken(tenantId, revoke[1]!, `portal:${user.email}`) });
      }
      if (req.method === "POST" && url.pathname === "/api/checkout") {
        if (!o.stripe) return json(503, { error: "billing is not configured on this portal yet; email us and we move the plan by hand" });
        await jsonBody();
        if (tenant.plan !== "free") return json(409, { error: `this tenant is already on the ${tenant.plan} plan` });
        const portalUrl = (o.portalUrl ?? "http://localhost/").replace(/\/?$/, "/");
        const session = await stripeRequest(o.stripe, "checkout/sessions", { mode: "subscription", "line_items[0][price]": o.stripe.priceTeam, "line_items[0][quantity]": "1", client_reference_id: tenantId, customer_email: user.email, success_url: `${portalUrl}?upgraded=1`, cancel_url: `${portalUrl}?cancelled=1`, "metadata[tenant]": tenantId });
        return json(200, { url: String(session.url) });
      }
      if (req.method === "POST" && url.pathname === "/api/billing-portal") {
        if (!o.stripe) return json(503, { error: "billing is not configured" });
        await jsonBody();
        const b = await store.billing(tenantId);
        if (!b?.customerId) return json(409, { error: "no billing record for this tenant" });
        const session = await stripeRequest(o.stripe, "billing_portal/sessions", { customer: b.customerId, return_url: (o.portalUrl ?? "http://localhost/").replace(/\/?$/, "/") });
        return json(200, { url: String(session.url) });
      }
      return json(404, { error: "not found" });
    } catch (e) {
      if (!res.headersSent) json(500, { error: e instanceof Error ? e.message : String(e) });
    }
  };
}

export function servePortal(o: PortalOptions, opts: { port: number; host?: string }): Promise<RunningPortal> {
  const host = opts.host ?? "127.0.0.1";
  const handler = portalHandler(o);
  const server: HttpServer = createServer((req, res) => void handler(req, res));
  return new Promise((resolve) => {
    server.listen(opts.port, host, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://${host}:${port}/`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) });
    });
  });
}

// ---- the page: one file, no framework, no outside requests ----
const PORTAL_PAGE = `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent-custody</title>
<style>
  :root { color-scheme: light dark; --ink: #1b2430; --ink2: #5b6b7a; --line: #d7dfe5; --bg: #f5f7f9; --panel: #ffffff; --accent: #0f6e63; --accent-bg: #e8f3f1; --warn: #b3731a; --bad: #b3261e; --ok: #1f7a4d; --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  @media (prefers-color-scheme: dark) { :root { --ink: #e6ecf0; --ink2: #9fb0bd; --line: #27333c; --bg: #0e1418; --panel: #151d23; --accent: #4fc3b0; --accent-bg: #16302b; --warn: #e2b862; --bad: #ff8a80; --ok: #6fd39a; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .top { display: flex; align-items: center; gap: 1rem; padding: .7rem 1.25rem; border-bottom: 1px solid var(--line); background: var(--panel); }
  .brand { font-weight: 700; letter-spacing: .04em; } .brand b { color: var(--accent); }
  .top .who { margin-left: auto; color: var(--ink2); font-size: .9rem; }
  .pill { display: inline-block; padding: .05rem .5rem; border-radius: 999px; font: 600 .72rem/1.6 var(--mono); letter-spacing: .06em; text-transform: uppercase; background: var(--accent-bg); color: var(--accent); }
  .layout { display: grid; grid-template-columns: 15rem 1fr; min-height: calc(100vh - 3.3rem); }
  nav { border-right: 1px solid var(--line); background: var(--panel); padding: 1rem 0; }
  nav .group { font: 600 .68rem/1.4 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--accent); padding: 1rem 1.25rem .35rem; }
  nav a { display: flex; justify-content: space-between; padding: .45rem 1.25rem; color: var(--ink); text-decoration: none; border-left: 3px solid transparent; }
  nav a.on { border-left-color: var(--accent); background: var(--accent-bg); }
  nav a span.n { color: var(--ink2); font-family: var(--mono); font-size: .8rem; }
  main { padding: 1.5rem; max-width: 72rem; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; } h2 { font: 600 .72rem/1.4 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--ink2); margin: 1.5rem 0 .6rem; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: .9rem; }
  .card { background: var(--panel); border: 1px solid var(--line); border-top: 3px solid var(--accent); border-radius: 6px; padding: 1rem 1.1rem; }
  .card.warn { border-top-color: var(--warn); } .card.bad { border-top-color: var(--bad); } .card.ok { border-top-color: var(--ok); }
  .card .k { font: 600 .68rem/1.4 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--ink2); }
  .card .v { font-size: 1.9rem; font-weight: 700; margin: .2rem 0 0; font-variant-numeric: tabular-nums; }
  .card .s { color: var(--ink2); font-size: .88rem; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 1rem 1.1rem; margin-top: .9rem; }
  table { border-collapse: collapse; width: 100%; font-size: .92rem; }
  th, td { text-align: left; padding: .45rem .5rem .45rem 0; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font: 600 .68rem/1.4 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--ink2); }
  code, pre, .mono { font-family: var(--mono); font-size: .86em; }
  pre { background: var(--bg); border: 1px solid var(--line); border-radius: 4px; padding: .8rem .9rem; overflow-x: auto; white-space: pre-wrap; }
  .bars { display: grid; grid-template-columns: repeat(6, 1fr); gap: .6rem; align-items: end; height: 9rem; }
  .bar { display: flex; flex-direction: column; justify-content: flex-end; align-items: center; height: 100%; font-size: .75rem; color: var(--ink2); }
  .bar i { display: block; width: 70%; background: var(--accent); border-radius: 3px 3px 0 0; min-height: 2px; }
  .bar b { font-family: var(--mono); font-weight: 400; margin-top: .3rem; }
  label { display: grid; gap: .25rem; font-size: .85rem; color: var(--ink2); margin: 0 0 .8rem; }
  input, select { font: inherit; padding: .5rem .6rem; border: 1px solid var(--line); border-radius: 4px; background: var(--bg); color: var(--ink); }
  button { font: inherit; padding: .5rem .9rem; border-radius: 4px; border: 1px solid var(--accent); background: var(--accent); color: #fff; cursor: pointer; }
  button.quiet { background: transparent; color: var(--accent); }
  button.link { background: none; border: 0; padding: 0; color: var(--accent); text-decoration: underline; }
  .auth { max-width: 26rem; margin: 4rem auto; }
  .once { border: 1px solid var(--warn); background: color-mix(in srgb, var(--warn) 10%, var(--panel)); border-radius: 6px; padding: 1rem 1.1rem; margin: 1rem 0; }
  .tok { font-family: var(--mono); word-break: break-all; padding: .6rem; background: var(--bg); border-radius: 4px; }
  .msg { min-height: 1.4rem; margin: .6rem 0; color: var(--ink2); } .msg.err { color: var(--bad); } .msg.ok { color: var(--ok); }
  .muted { color: var(--ink2); }
  [hidden] { display: none !important; }
  @media (max-width: 48rem) { .layout { grid-template-columns: 1fr; } nav { display: flex; flex-wrap: wrap; padding: .3rem; border-right: 0; border-bottom: 1px solid var(--line); } nav .group { display: none; } nav a { border-left: 0; border-bottom: 3px solid transparent; } nav a.on { border-bottom-color: var(--accent); } }
</style>
<div class="top"><span class="brand"><b>◆</b> agent-custody</span><span id="tenantTag" class="pill" hidden></span><span id="planTag" class="pill" hidden></span><span class="who" id="who"></span></div>
<section id="auth" class="auth" hidden>
  <h1 id="authTitle">Sign in</h1>
  <form id="authForm">
    <label>Email<input id="email" type="email" autocomplete="email" required></label>
    <label>Password<input id="password" type="password" autocomplete="current-password" minlength="10" required></label>
    <label id="tenantField" hidden>Tenant id, the name in your log's URL<input id="tenant" placeholder="acme" pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]"></label>
    <button id="authGo" type="submit">Sign in</button>
    <p class="msg" id="authMsg"></p>
  </form>
  <p class="muted"><button class="link" id="authSwap" type="button">Create an account and a tenant instead</button></p>
  <p class="muted">The free plan is ten thousand appends a month, no card. Your gateway sends only hashes; nothing you log here can be read by us.</p>
</section>
<section id="welcome" class="auth" hidden>
  <h1>Your tenant is ready</h1>
  <div class="once"><p><b>Your first API key, shown once.</b> Put it in the environment your gateway reads as <code>AGENT_CUSTODY_LOG_TOKEN</code>. We keep only its hash.</p><p class="tok" id="firstToken"></p><button class="quiet" id="copyFirst">Copy key</button></div>
  <h2>Your welcome sheet</h2>
  <pre id="firstSheet"></pre>
  <button id="toDash">Go to the dashboard</button>
</section>
<div class="layout" id="app" hidden>
  <nav>
    <div class="group">Monitor</div>
    <a href="#overview" data-view="overview">Overview</a>
    <a href="#usage" data-view="usage">Usage</a>
    <div class="group">Configure</div>
    <a href="#keys" data-view="keys">API keys <span class="n" id="nKeys"></span></a>
    <a href="#billing" data-view="billing">Billing</a>
    <a href="#export" data-view="export">Export</a>
    <div class="group">Account</div>
    <a href="#" id="signout">Sign out</a>
  </nav>
  <main>
    <div data-pane="overview">
      <h1>Overview</h1>
      <div class="cards">
        <div class="card" id="cUsed"><div class="k">Appends this month</div><div class="v" id="vUsed">–</div><div class="s" id="sUsed"></div></div>
        <div class="card" id="cSize"><div class="k">Receipts in your log</div><div class="v" id="vSize">–</div><div class="s">leaf hashes, all time</div></div>
        <div class="card" id="cKeys"><div class="k">Live keys</div><div class="v" id="vKeys">–</div><div class="s" id="sKeys"></div></div>
        <div class="card" id="cCp"><div class="k">Latest checkpoint</div><div class="v" id="vCp">–</div><div class="s" id="sCp"></div></div>
      </div>
      <h2>Your log</h2>
      <div class="panel"><table><tbody id="urls"></tbody></table></div>
      <h2>Recent activity</h2>
      <div class="panel"><table><thead><tr><th>when</th><th>who</th><th>action</th><th>detail</th></tr></thead><tbody id="audit"></tbody></table></div>
    </div>
    <div data-pane="usage" hidden>
      <h1>Usage</h1>
      <div class="panel"><div class="bars" id="bars"></div></div>
      <p class="muted" id="usageNote"></p>
    </div>
    <div data-pane="keys" hidden>
      <h1>API keys</h1>
      <p class="muted">A key is a bearer token your gateway presents on append. It is shown once when minted; we keep only its hash. Mint a second key before revoking the first to rotate without a gap.</p>
      <div class="panel"><form id="mintForm" style="display:flex;gap:.6rem;align-items:end;flex-wrap:wrap"><label style="margin:0">Label<input id="label" placeholder="support fleet"></label><button type="submit">Mint key</button></form>
        <div id="minted" class="once" hidden><p><b>Shown once.</b></p><p class="tok" id="mintedTok"></p><button class="quiet" id="copyMinted">Copy key</button></div>
        <table style="margin-top:1rem"><thead><tr><th>label</th><th>hash</th><th>created</th><th>state</th><th></th></tr></thead><tbody id="keys"></tbody></table></div>
      <p class="msg" id="keysMsg"></p>
    </div>
    <div data-pane="billing" hidden>
      <h1>Billing</h1>
      <div class="panel" id="billingPanel"></div>
      <p class="msg" id="billingMsg"></p>
    </div>
    <div data-pane="export" hidden>
      <h1>Export</h1>
      <p class="muted">Everything the log holds about you, any time, with your key: every leaf hash as a log file the verifier reads offline, the signed head, the published keys, the checkpoints, your usage, and the actions taken on your tenant. It checks itself before writing.</p>
      <pre id="exportCmd"></pre>
      <h2>Welcome sheet</h2>
      <pre id="sheet"></pre>
    </div>
  </main>
</div>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const api = async (method, path, body) => {
    const r = await fetch(path, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: "same-origin" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || r.statusText); e.status = r.status; throw e; }
    return j;
  };
  const fmt = (n) => Number(n).toLocaleString();
  const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " d ago"; };
  let registering = false;
  const show = (id) => { for (const s of ["auth", "welcome", "app"]) $(s).hidden = s !== id; };
  const view = (name) => {
    for (const p of document.querySelectorAll("[data-pane]")) p.hidden = p.dataset.pane !== name;
    for (const a of document.querySelectorAll("nav a[data-view]")) a.classList.toggle("on", a.dataset.view === name);
    location.hash = name;
  };
  $("authSwap").onclick = () => { registering = !registering; $("authTitle").textContent = registering ? "Create your tenant" : "Sign in"; $("authGo").textContent = registering ? "Create tenant" : "Sign in"; $("tenantField").hidden = !registering; $("tenant").required = registering; $("password").autocomplete = registering ? "new-password" : "current-password"; $("authSwap").textContent = registering ? "I already have an account" : "Create an account and a tenant instead"; };
  $("authForm").onsubmit = async (e) => {
    e.preventDefault(); $("authMsg").className = "msg"; $("authMsg").textContent = "";
    try {
      if (registering) {
        const r = await api("POST", "/api/register", { email: $("email").value, password: $("password").value, tenant: $("tenant").value });
        $("firstToken").textContent = r.token; $("firstSheet").textContent = r.welcome; show("welcome");
      } else { await api("POST", "/api/login", { email: $("email").value, password: $("password").value }); await enter(); }
    } catch (err) { $("authMsg").className = "msg err"; $("authMsg").textContent = err.message; }
  };
  $("copyFirst").onclick = () => navigator.clipboard.writeText($("firstToken").textContent);
  $("toDash").onclick = () => enter();
  $("signout").onclick = async (e) => { e.preventDefault(); await api("POST", "/api/logout", {}); location.hash = ""; show("auth"); };
  for (const a of document.querySelectorAll("nav a[data-view]")) a.onclick = (e) => { e.preventDefault(); view(a.dataset.view); };
  const render = (o) => {
    $("tenantTag").textContent = o.tenant; $("tenantTag").hidden = false; $("planTag").textContent = o.plan + " plan"; $("planTag").hidden = false;
    const pct = o.quota ? o.used / o.quota : 0;
    $("cUsed").className = "card " + (o.quota === null ? "ok" : pct >= 1 ? "bad" : pct >= .8 ? "warn" : "ok");
    $("vUsed").textContent = fmt(o.used); $("sUsed").textContent = o.quota === null ? "no allowance on " + o.plan : "of " + fmt(o.quota) + " on " + o.plan + (pct >= 1 ? ": appends are refused until next month" : "");
    $("vSize").textContent = fmt(o.treeSize);
    const live = o.keys.filter((k) => !k.revokedAt).length; $("vKeys").textContent = live; $("sKeys").textContent = o.keys.length - live + " revoked"; $("nKeys").textContent = live;
    $("cCp").className = "card " + (o.latestCheckpoint ? (Date.now() - Date.parse(o.latestCheckpoint.signedAt) < 7 * 3600e3 ? "ok" : "warn") : "warn");
    $("vCp").textContent = o.latestCheckpoint ? "size " + fmt(o.latestCheckpoint.treeSize) : "none yet"; $("sCp").textContent = o.latestCheckpoint ? "signed " + ago(o.latestCheckpoint.signedAt) : "published after your first append";
    $("urls").innerHTML = [["Append here", o.urls.log], ["Log id on tree heads", o.logId], ["The log's keys", o.urls.keys], ["Your checkpoints", o.urls.checkpoints || "(not published)"], ["Current root", o.rootHash || "(empty)"]].map(([k, v]) => "<tr><th>" + esc(k) + "</th><td class=mono>" + esc(v) + "</td></tr>").join("");
    $("audit").innerHTML = o.audit.map((e) => "<tr><td>" + esc(e.at.replace("T", " ").slice(0, 16)) + "</td><td class=mono>" + esc(e.actor) + "</td><td>" + esc(e.action) + "</td><td class=muted>" + esc(Object.entries(e.detail).map(([k, v]) => k + "=" + v).join(" ")) + "</td></tr>").join("") || "<tr><td colspan=4 class=muted>nothing yet</td></tr>";
    const max = Math.max(1, ...o.months.map((m) => m.appends));
    $("bars").innerHTML = o.months.map((m) => "<div class=bar><span class=mono>" + fmt(m.appends) + "</span><i style=\\"height:" + Math.max(2, Math.round(100 * m.appends / max)) + "%\\"></i><b>" + esc(m.month.slice(2)) + "</b></div>").join("");
    $("usageNote").textContent = "Appends per calendar month, UTC. Your plan allows " + (o.quota === null ? "any number" : fmt(o.quota)) + " a month; the count resets on the first.";
    $("keys").innerHTML = o.keys.map((k) => "<tr><td>" + esc(k.label) + "</td><td class=mono>" + esc(k.hash) + "</td><td>" + esc(k.createdAt.slice(0, 10)) + "</td><td>" + (k.revokedAt ? "revoked " + esc(k.revokedAt.slice(0, 10)) : "live") + "</td><td>" + (k.revokedAt ? "" : "<button class=quiet data-revoke=\\"" + esc(k.hash) + "\\">Revoke</button>") + "</td></tr>").join("");
    $("billingPanel").innerHTML = o.plan === "free"
      ? "<p>You are on the <b>free</b> plan: ten thousand appends a month, no card.</p><p>The <b>team</b> plan is <b>$50 a month</b>: a million appends, email support within two working days, the same export and audit trail. No availability commitment yet, and the design fails closed: when the log is unreachable your gateway withholds pre-committed calls.</p>" + (o.stripe ? "<button id=upgrade>Upgrade to team, $50/month</button>" : "<p class=muted>Card payments are not switched on for this portal yet; email us and we move the plan by hand.</p>")
      : "<p>You are on the <b>" + esc(o.plan) + "</b> plan" + (o.billing ? " (subscription " + esc(o.billing.status) + ")" : "") + ".</p>" + (o.stripe && o.billing ? "<button class=quiet id=manage>Manage billing</button>" : "");
    $("exportCmd").textContent = o.exportCommand; $("sheet").textContent = o.welcome;
    const up = $("upgrade"); if (up) up.onclick = async () => { try { const r = await api("POST", "/api/checkout", {}); location.href = r.url; } catch (err) { $("billingMsg").className = "msg err"; $("billingMsg").textContent = err.message; } };
    const mg = $("manage"); if (mg) mg.onclick = async () => { try { const r = await api("POST", "/api/billing-portal", {}); location.href = r.url; } catch (err) { $("billingMsg").className = "msg err"; $("billingMsg").textContent = err.message; } };
  };
  const load = async () => render(await api("GET", "/api/overview"));
  const enter = async () => {
    try { const me = await api("GET", "/api/me"); $("who").textContent = me.email; show("app"); await load(); view((location.hash || "#overview").slice(1) || "overview"); }
    catch (err) { if (err.status === 401) show("auth"); else { show("app"); $("who").textContent = err.message; } }
  };
  $("mintForm").onsubmit = async (e) => { e.preventDefault(); try { const r = await api("POST", "/api/keys", { label: $("label").value }); $("mintedTok").textContent = r.token; $("minted").hidden = false; $("keysMsg").className = "msg ok"; $("keysMsg").textContent = "minted " + r.label + ", stored as hash " + r.tokenHash; await load(); } catch (err) { $("keysMsg").className = "msg err"; $("keysMsg").textContent = err.message; } };
  $("copyMinted").onclick = () => navigator.clipboard.writeText($("mintedTok").textContent);
  document.addEventListener("click", async (e) => { const b = e.target.closest("button[data-revoke]"); if (!b) return; if (!confirm("Revoke key " + b.dataset.revoke + "? A gateway using it stops appending at once.")) return; try { await api("POST", "/api/keys/" + b.dataset.revoke + "/revoke", {}); $("keysMsg").className = "msg ok"; $("keysMsg").textContent = "revoked"; await load(); } catch (err) { $("keysMsg").className = "msg err"; $("keysMsg").textContent = err.message; } });
  if (new URLSearchParams(location.search).get("upgraded")) history.replaceState(null, "", "/#billing");
  enter();
})();
</script>
`;

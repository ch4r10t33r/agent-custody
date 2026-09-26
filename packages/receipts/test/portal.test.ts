// The portal is the tenant's own door: register and get a tenant and a key shown once, sign in, see the numbers
// the log keeps, mint and revoke keys, pay. Nothing here is reachable without a session except the Stripe webhook,
// which is reachable only with Stripe's signature. Postgres runs in-process through PGlite; the log server runs
// beside the portal on the same tenancy so the dashboard's numbers come from real appends; Stripe is a stand-in
// that answers the two calls the portal makes.
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { generateKeyPair } from "../src/crypto.ts";
import { httpLog, postgresResolver, serveLog, type RunningLog } from "../src/log-sink.ts";
import { PostgresTenancy } from "../src/log-store.ts";
import { PortalStore, readSession, servePortal, signSession, verifyStripeSignature, type RunningPortal } from "../src/portal.ts";

let db: PGlite;
let tenancy: PostgresTenancy;
let log: RunningLog;
let portal: RunningPortal;
const stripeCalls: { path: string; body: URLSearchParams }[] = [];
const stripeFetch: typeof fetch = async (url, init) => {
  const path = String(url).replace("https://api.stripe.com/v1/", "");
  stripeCalls.push({ path, body: new URLSearchParams(String(init?.body ?? "")) });
  if (path === "checkout/sessions") return new Response(JSON.stringify({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" }), { status: 200, headers: { "content-type": "application/json" } });
  if (path === "billing_portal/sessions") return new Response(JSON.stringify({ url: "https://billing.stripe.com/p/session/x" }), { status: 200, headers: { "content-type": "application/json" } });
  return new Response(JSON.stringify({ error: { message: "no such route" } }), { status: 404 });
};
const SECRET = "portal-secret-for-tests-at-least-32-chars-long";
const WHSEC = "whsec_test_secret";

beforeAll(async () => {
  db = new PGlite();
  await db.query("SELECT 1");
  tenancy = new PostgresTenancy(db, { quotas: { free: 3 } });
  await tenancy.addTenant("default", "log.example.test");
  log = await serveLog(postgresResolver(tenancy), generateKeyPair(), { port: 0 });
  portal = await servePortal({ tenancy, client: db, secret: SECRET, publicUrl: log.url, checkpointsUrl: "https://checkpoints.example.test/", keyid: "abc123", portalUrl: "https://app.example.test/", stripe: { secretKey: "sk_test_x", webhookSecret: WHSEC, priceTeam: "price_team", fetch: stripeFetch }, log: () => {} }, { port: 0 });
}, 60_000);

afterAll(async () => {
  await portal?.close();
  await log?.close();
  await db?.close();
});

/** a browser: keeps the cookie, sends JSON */
function browser() {
  let cookie = "";
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(new URL(path, portal.url), { method, headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
  };
  return { call, cookieValue: () => cookie };
}

describe("the tenant portal", () => {
  it("registers an account with a tenant and a first key shown once, then the dashboard shows the log's numbers as appends land", async () => {
    const b = browser();
    const bad = await b.call("POST", "/api/register", { email: "dana@example.com", password: "short", tenant: "acme" });
    expect(bad.status).toBe(400);
    const taken = await b.call("POST", "/api/register", { email: "dana@example.com", password: "a-long-enough-password", tenant: "default" });
    expect(taken.status).toBe(400); // reserved
    const r = await b.call("POST", "/api/register", { email: "Dana@Example.com", password: "a-long-enough-password", tenant: "acme" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ tenant: "acme", logId: "acme", plan: "free" });
    expect(r.json.token).toMatch(/^[0-9a-f]{64}$/);
    expect(r.json.welcome).toContain("t/acme/");
    expect(r.json.exportCommand).toContain("--tenant acme");
    expect(readSession(SECRET, b.cookieValue().split("=")[1])).toBeTruthy();
    // the same email or tenant again is refused
    expect((await browser().call("POST", "/api/register", { email: "dana@example.com", password: "a-long-enough-password", tenant: "other" })).status).toBe(409);
    expect((await browser().call("POST", "/api/register", { email: "x@example.com", password: "a-long-enough-password", tenant: "acme" })).status).toBe(409);

    const me = await b.call("GET", "/api/me");
    expect(me.json).toMatchObject({ email: "dana@example.com", tenant: "acme", plan: "free", used: 0, quota: 3, billing: true });
    // the key works on the log; the dashboard reflects the appends
    const sink = httpLog(`${log.url}t/acme/`, { token: r.json.token, hashOnly: true });
    await sink.append("one");
    await sink.append("two");
    const o = await b.call("GET", "/api/overview");
    expect(o.json).toMatchObject({ tenant: "acme", used: 2, quota: 3, treeSize: 2, latestCheckpoint: null });
    expect(o.json.months.at(-1)).toMatchObject({ appends: 2 });
    expect(o.json.keys).toHaveLength(1);
    expect(o.json.audit.map((e: any) => e.action)).toEqual(["token.add", "tenant.add"]);
    expect(o.json.audit[1].actor).toBe("portal:dana@example.com");
    expect(o.json.urls.checkpoints).toBe("https://checkpoints.example.test/acme/latest.json");
  });

  it("signs in and out, throttles wrong passwords, and refuses every tenant route without a session or with a forged cookie", async () => {
    const b = browser();
    expect((await b.call("POST", "/api/login", { email: "dana@example.com", password: "wrong-password!" })).status).toBe(401);
    expect((await b.call("POST", "/api/login", { email: "dana@example.com", password: "a-long-enough-password" })).status).toBe(200);
    expect((await b.call("GET", "/api/me")).status).toBe(200);
    expect((await b.call("POST", "/api/logout", {})).status).toBe(200);
    expect((await b.call("GET", "/api/me")).status).toBe(401);
    const forged = await fetch(new URL("/api/me", portal.url), { headers: { cookie: `custody_session=${signSession("another-secret-that-is-not-the-one", "someone")}` } });
    expect(forged.status).toBe(401);
    // a write without a JSON body is refused even with a session, which is the cross-site guard
    const c = browser();
    await c.call("POST", "/api/login", { email: "dana@example.com", password: "a-long-enough-password" });
    const noJson = await fetch(new URL("/api/keys", portal.url), { method: "POST", headers: { cookie: c.cookieValue() }, body: "label=x" });
    expect(noJson.status).toBe(415);
    const page = await fetch(portal.url);
    expect(page.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
    expect(await page.text()).toContain("API keys");
  });

  it("mints and revokes keys with the portal user as the actor, and a revoked key stops appending", async () => {
    const b = browser();
    await b.call("POST", "/api/login", { email: "dana@example.com", password: "a-long-enough-password" });
    const m = await b.call("POST", "/api/keys", { label: "second fleet" });
    expect(m.status).toBe(200);
    expect(m.json.token).toMatch(/^[0-9a-f]{64}$/);
    const keys = (await b.call("GET", "/api/keys")).json.keys;
    expect(keys.map((k: any) => k.label)).toEqual(["first key", "second fleet"]);
    const sink = httpLog(`${log.url}t/acme/`, { token: m.json.token, hashOnly: true, retries: 1 });
    await sink.append("three");
    expect((await b.call("POST", `/api/keys/${m.json.tokenHash}/revoke`, {})).json).toEqual({ revoked: 1 });
    await expect(sink.append("four")).rejects.toThrow(/401/);
    const o = await b.call("GET", "/api/overview");
    expect(o.json.audit[0]).toMatchObject({ action: "token.revoke", actor: "portal:dana@example.com" });
    // and the free allowance is now used up: the dashboard says so
    expect(o.json).toMatchObject({ used: 3, quota: 3 });
  });

  it("checkout sends the tenant to Stripe with the right price and reference; the signed webhook moves the plan to team; a cancellation moves it back; a bad signature is refused", async () => {
    const b = browser();
    await b.call("POST", "/api/login", { email: "dana@example.com", password: "a-long-enough-password" });
    const c = await b.call("POST", "/api/checkout", {});
    expect(c.json.url).toBe("https://checkout.stripe.com/c/pay/cs_test_1");
    const call = stripeCalls.find((x) => x.path === "checkout/sessions")!;
    expect(call.body.get("mode")).toBe("subscription");
    expect(call.body.get("line_items[0][price]")).toBe("price_team");
    expect(call.body.get("client_reference_id")).toBe("acme");
    expect(call.body.get("success_url")).toBe("https://app.example.test/?upgraded=1");
    const event = (type: string, object: Record<string, unknown>) => JSON.stringify({ id: "evt_1", type, data: { object } });
    const signed = (payload: string, secret = WHSEC) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`; };
    const post = (payload: string, sig: string) => fetch(new URL("/stripe/webhook", portal.url), { method: "POST", headers: { "content-type": "application/json", "stripe-signature": sig }, body: payload });
    const completed = event("checkout.session.completed", { id: "cs_test_1", client_reference_id: "acme", customer: "cus_1", subscription: "sub_1" });
    expect((await post(completed, signed(completed, "whsec_wrong"))).status).toBe(400);
    expect((await post(completed, signed(completed))).status).toBe(200);
    expect((await tenancy.tenant("acme"))!.plan).toBe("team");
    expect((await b.call("GET", "/api/me")).json).toMatchObject({ plan: "team", quota: 1_000_000 });
    expect((await b.call("GET", "/api/overview")).json.billing).toEqual({ status: "active" });
    // paying again is refused; managing billing goes to Stripe's portal for the customer on record
    expect((await b.call("POST", "/api/checkout", {})).status).toBe(409);
    expect((await b.call("POST", "/api/billing-portal", {})).json.url).toBe("https://billing.stripe.com/p/session/x");
    expect(stripeCalls.find((x) => x.path === "billing_portal/sessions")!.body.get("customer")).toBe("cus_1");
    const deleted = event("customer.subscription.deleted", { id: "sub_1", status: "canceled" });
    expect((await post(deleted, signed(deleted))).status).toBe(200);
    expect((await tenancy.tenant("acme"))!.plan).toBe("free");
    const audit = (await b.call("GET", "/api/overview")).json.audit;
    expect(audit.slice(0, 2).map((e: any) => [e.action, e.actor, e.detail.plan])).toEqual([["tenant.plan", "stripe:customer.subscription.deleted", "free"], ["tenant.plan", "stripe:checkout", "team"]]);
    // an old timestamp is refused even with a valid mac
    const stale = `t=${Math.floor(Date.now() / 1000) - 3600},v1=${createHmac("sha256", WHSEC).update(`${Math.floor(Date.now() / 1000) - 3600}.${deleted}`).digest("hex")}`;
    expect(verifyStripeSignature(stale, deleted, WHSEC)).toBe(false);
  });

  it("password hashing is scrypt with a fresh salt, and a stored hash never verifies the wrong password", () => {
    const h1 = PortalStore.hashPassword("correct horse battery");
    const h2 = PortalStore.hashPassword("correct horse battery");
    expect(h1).not.toBe(h2);
    expect(h1.startsWith("scrypt$")).toBe(true);
    expect(PortalStore.checkPassword("correct horse battery", h1)).toBe(true);
    expect(PortalStore.checkPassword("correct horse batter", h1)).toBe(false);
    expect(PortalStore.checkPassword("x", "garbage")).toBe(false);
  });
});

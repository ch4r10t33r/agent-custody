// The admin surface is the operator's, not the tenant's: nothing under /admin answers without the admin token, a
// minted token works on the tenant's path and stops working when revoked, and the page ships with no outside
// requests. Postgres runs in-process through PGlite.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { generateKeyPair } from "../src/crypto.ts";
import { postgresResolver, serveLog, type RunningLog } from "../src/log-sink.ts";
import { PostgresTenancy } from "../src/log-store.ts";
import { welcomeSheet } from "../src/log-admin.ts";

let db: PGlite;
let log: RunningLog;
let tenancy: PostgresTenancy;
const ADMIN = "admin-secret-for-tests";

beforeAll(async () => {
  db = new PGlite();
  await db.query("SELECT 1");
  tenancy = new PostgresTenancy(db);
  await tenancy.addTenant("default", "log.example.test");
  log = await serveLog(postgresResolver(tenancy), generateKeyPair(), { port: 0, admin: { tenancy, token: ADMIN, publicUrl: "https://log.example.test/", checkpointsUrl: "https://checkpoints.example.test/" } });
}, 60_000);
afterAll(async () => {
  await log.close();
  await db.close();
});

const call = (method: string, path: string, body?: unknown, token: string | null = ADMIN) => fetch(new URL(path, log.url), { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });

describe("the admin surface", () => {
  it("nothing under /admin answers without the token, the page included; the browser's Basic credential and a bearer both work; the page has a strict CSP", async () => {
    const bare = await call("GET", "admin", undefined, null);
    expect(bare.status).toBe(401);
    expect(bare.headers.get("www-authenticate")).toMatch(/^Basic realm=/);
    const basic = await fetch(new URL("admin", log.url), { headers: { authorization: `Basic ${Buffer.from(`anyone:${ADMIN}`).toString("base64")}` } });
    expect(basic.status).toBe(200);
    expect(basic.headers.get("content-type")).toMatch(/text\/html/);
    expect(basic.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
    const html = await basic.text();
    expect(html).toContain("Log admin");
    expect(html).not.toMatch(/https?:\/\/(?!agent-custody\.dev)/); // no third-party requests
    expect(html).not.toContain("sessionStorage");
    for (const [m, p] of [["GET", "admin/tenants"], ["POST", "admin/tenants"], ["GET", "admin/info"]] as const) {
      expect((await call(m, p, m === "POST" ? { id: "x" } : undefined, null)).status).toBe(401);
    }
    const viaBasic = await fetch(new URL("admin/info", log.url), { headers: { authorization: `Basic ${Buffer.from(`x:${ADMIN}`).toString("base64")}` } });
    expect(viaBasic.status).toBe(200);
  });

  it("behind a trusted proxy the throttle keys on the forwarded address, so one client's failures do not lock out another", async () => {
    const db2 = new PGlite();
    await db2.query("SELECT 1");
    const t2 = new PostgresTenancy(db2);
    await t2.addTenant("default", "x");
    const proxied = await serveLog(postgresResolver(t2), generateKeyPair(), { port: 0, trustProxy: true, admin: { tenancy: t2, token: ADMIN } });
    try {
      const attempt = (ip: string, token: string) => fetch(new URL("admin/info", proxied.url), { headers: { authorization: `Bearer ${token}`, "x-forwarded-for": `${ip}, 10.0.0.1` } });
      let last = 0;
      for (let i = 0; i < 8; i++) last = (await attempt("203.0.113.5", "wrong")).status;
      expect(last).toBe(429);
      expect((await attempt("203.0.113.6", "wrong")).status).toBe(401); // a different client is not throttled
      expect((await attempt("203.0.113.6", ADMIN)).status).toBe(200);
    } finally {
      await proxied.close();
      await db2.close();
    }
    // without trustProxy the header is ignored: every request here is the same socket address
    const spoofed = await fetch(new URL("admin/info", log.url), { headers: { authorization: `Bearer ${ADMIN}`, "x-forwarded-for": "198.51.100.9" } });
    expect(spoofed.status).toBe(200);
  }, 30_000);

  it("wrong tokens from one address are throttled after a handful of tries", async () => {
    let last = 0;
    for (let i = 0; i < 8; i++) last = (await call("GET", "admin/info", undefined, `wrong-${i}`)).status;
    expect(last).toBe(429);
    // the right token still works from the same address: the throttle is on failures, not on the address
    expect((await call("GET", "admin/info")).status).toBe(200);
  });

  it("creates a tenant, mints a token shown once with the welcome sheet, the token appends on the tenant's path, and revocation stops it", async () => {
    const info = (await (await call("GET", "admin/info")).json()) as { publicUrl: string; keyid: string };
    expect(info.publicUrl).toBe("https://log.example.test/");
    expect(info.keyid).toMatch(/^[0-9a-f]{64}$/);
    const made = (await (await call("POST", "admin/tenants", { id: "acme", logId: "acme-eu" })).json()) as { id: string; logId: string };
    expect(made).toMatchObject({ id: "acme", logId: "acme-eu" });
    expect((await call("POST", "admin/tenants", { id: "bad id" })).status).toBe(400);
    const listed = (await (await call("GET", "admin/tenants")).json()) as { id: string; tokens: number }[];
    expect(listed.map((t) => [t.id, t.tokens])).toEqual([["default", 0], ["acme", 0]]);
    const minted = (await (await call("POST", "admin/tenants/acme/tokens", { label: "support fleet" })).json()) as { token: string; tokenHash: string; welcome: string };
    expect(minted.token).toMatch(/^[0-9a-f]{64}$/);
    expect(minted.welcome).toContain("https://log.example.test/t/acme/");
    expect(minted.welcome).toContain("--log-id acme-eu");
    expect(minted.welcome).toContain("https://checkpoints.example.test/acme/latest.json");
    expect(minted.welcome).toContain(info.keyid);
    const append = (token: string) => fetch(new URL("t/acme/append", log.url), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ leafHash: "ab".repeat(32) }) });
    expect((await append(minted.token)).status).toBe(200);
    expect((await append(ADMIN)).status).toBe(401); // the admin token is not a tenant token
    const tokens = (await (await call("GET", "admin/tenants/acme/tokens")).json()) as { label: string; tokenHash: string; revokedAt: string | null }[];
    expect(tokens).toEqual([{ label: "support fleet", tokenHash: minted.tokenHash, createdAt: expect.any(String), revokedAt: null, tenantId: "acme" }]);
    expect(await (await call("POST", `admin/tenants/acme/tokens/${minted.tokenHash.slice(0, 12)}/revoke`)).json()).toEqual({ revoked: 1 });
    expect((await append(minted.token)).status).toBe(401);
    expect((await call("POST", "admin/tenants/nobody/tokens", { label: "x" })).status).toBe(404);
    await call("POST", "admin/tenants/acme/disable");
    expect((await (await call("GET", "admin/tenants")).json() as { id: string; disabledAt: string | null }[]).find((t) => t.id === "acme")?.disabledAt).not.toBeNull();
  });

  it("the welcome sheet is the same text the server script prints, with the tenant's URL, id, and commands", () => {
    const sheet = welcomeSheet({ tenant: "globex", logId: "globex-us", publicUrl: "https://log.example.test", checkpointsUrl: "https://checkpoints.example.test", keyid: "abc" });
    expect(sheet).toContain('"url": "https://log.example.test/t/globex/"');
    expect(sheet).toContain("--log-url https://log.example.test/t/globex/ --log-id globex-us");
    expect(sheet).toContain("https://checkpoints.example.test/globex/latest.json");
    expect(sheet).toContain("(current keyid abc)");
    expect(sheet).toContain("hashOnly");
  });
});

describe("the audit trail", () => {
  it("records every tenant and token change with who made it, shows it on the page and the API, and a tenant sees only their own rows in their export route", async () => {
    const basic = (user: string) => ({ authorization: `Basic ${Buffer.from(`${user}:${ADMIN}`).toString("base64")}`, "content-type": "application/json" });
    expect((await fetch(new URL("admin/tenants", log.url), { method: "POST", headers: basic("dana"), body: JSON.stringify({ id: "audited", logId: "audited-eu" }) })).status).toBe(200);
    const minted = (await (await fetch(new URL("admin/tenants/audited/tokens", log.url), { method: "POST", headers: basic("dana"), body: JSON.stringify({ label: "fleet-a" }) })).json()) as { token: string; tokenHash: string };
    const second = (await (await call("POST", "admin/tenants/audited/tokens", { label: "fleet-b" })).json()) as { token: string; tokenHash: string };
    expect((await call("POST", `admin/tenants/audited/tokens/${second.tokenHash.slice(0, 12)}/revoke`)).status).toBe(200);
    await tenancy.addTenant("bystander", "bystander", "cli:test@host");

    const all = ((await (await call("GET", "admin/audit?limit=10")).json()) as { entries: any[] }).entries;
    expect(all[0]).toMatchObject({ actor: "cli:test@host", action: "tenant.add", tenantId: "bystander", detail: { logId: "bystander" } });
    const mine = all.filter((e) => e.tenantId === "audited");
    expect(mine.map((e) => e.action)).toEqual(["token.revoke", "token.add", "token.add", "tenant.add"]);
    expect(mine[3].actor).toMatch(/^admin:dana@/);
    expect(mine[2].actor).toMatch(/^admin:dana@/);
    expect(mine[1].actor).toMatch(/^admin:bearer@/);
    expect(mine[0].detail).toEqual({ hashPrefix: second.tokenHash.slice(0, 12), revoked: 1 });
    expect(mine[2].detail).toEqual({ label: "fleet-a", tokenHash: minted.tokenHash.slice(0, 12) });
    expect(mine.every((e) => typeof e.at === "string" && !JSON.stringify(e).includes(minted.token))).toBe(true);
    const html = await (await call("GET", "admin")).text();
    expect(html).toContain("<h2>Activity</h2>");
    expect(html).toContain("/admin/audit");

    // the tenant's own view, with their token: their rows and nobody else's
    const own = (await (await fetch(new URL("t/audited/audit", log.url), { headers: { authorization: `Bearer ${minted.token}` } })).json()) as { entries: any[] };
    expect(own.entries.map((e) => e.action)).toEqual(["token.revoke", "token.add", "token.add", "tenant.add"]);
    expect(own.entries.some((e) => e.tenantId !== "audited")).toBe(false);
    expect((await fetch(new URL("t/audited/audit", log.url))).status).toBe(401);
    expect((await call("GET", "admin/audit?limit=0")).status).toBe(400);
  });
});

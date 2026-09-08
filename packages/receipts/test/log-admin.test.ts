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
  it("the page is public HTML with a strict CSP; everything else under /admin needs the admin token", async () => {
    const page = await call("GET", "admin", undefined, null);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(page.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
    const html = await page.text();
    expect(html).toContain("Log admin");
    expect(html).not.toMatch(/https?:\/\/(?!agent-custody\.dev)/); // no third-party requests
    for (const [m, p] of [["GET", "admin/tenants"], ["POST", "admin/tenants"], ["GET", "admin/info"]] as const) {
      expect((await call(m, p, m === "POST" ? { id: "x" } : undefined, null)).status).toBe(401);
      expect((await call(m, p, m === "POST" ? { id: "x" } : undefined, "wrong")).status).toBe(401);
    }
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

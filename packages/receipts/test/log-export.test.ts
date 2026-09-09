// A tenant's export is theirs to take: with their own token they get every leaf hash, the signed head, the keys,
// the checkpoints, and their usage, and the export checks that it all adds up before it is written. The leaves
// become a log file the verifier reads directly. Another tenant's token gets nothing.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { generateKeyPair } from "../src/crypto.ts";
import { dirCheckpoints } from "../src/checkpoints.ts";
import { MerkleLog } from "../src/log.ts";
import { exportLog, formatExport } from "../src/log-export.ts";
import { httpLog, postgresResolver, serveLog, type RunningLog } from "../src/log-sink.ts";
import { PostgresTenancy } from "../src/log-store.ts";

let db: PGlite;
let log: RunningLog;
let acmeToken: string;
let otherToken: string;

beforeAll(async () => {
  db = new PGlite();
  await db.query("SELECT 1");
  const tenancy = new PostgresTenancy(db, { prefix: "exp_" });
  await tenancy.addTenant("default", "log.example.test");
  await tenancy.addTenant("acme", "acme-eu");
  await tenancy.addTenant("other", "other-eu");
  acmeToken = (await tenancy.addToken("acme", "fleet")).token;
  otherToken = (await tenancy.addToken("other", "fleet")).token;
  const cpDir = mkdtempSync(join(tmpdir(), "export-cp-"));
  log = await serveLog(postgresResolver(tenancy), generateKeyPair(), { port: 0, checkpoints: dirCheckpoints(cpDir) });
}, 60_000);

afterAll(async () => {
  await log?.close();
  await db?.close();
});

describe("a tenant's export", () => {
  it("fetches every leaf in pages, verifies the head and checkpoints against the published keys, writes a log copy the verifier reads, and reports usage", async () => {
    const sink = httpLog(`${log.url}t/acme/`, { token: acmeToken, hashOnly: true });
    for (let i = 0; i < 7; i++) await sink.append(`leaf ${i}`);
    const out = join(mkdtempSync(join(tmpdir(), "export-")), "acme");
    // a page size of two exercises the paging; the CLI uses ten thousand
    const paged: typeof fetch = (url, init) => fetch(String(url).replace("limit=10000", "limit=2"), init);
    const r = await exportLog({ logUrl: log.url, tenant: "acme", token: acmeToken, outDir: out, fetch: paged, months: [new Date().toISOString().slice(0, 7)] });
    expect(r.problems).toEqual([]);
    expect(r).toMatchObject({ logId: "acme-eu", treeSize: 7, rootHash: expect.any(String) });
    expect(r.usage).toEqual([{ month: new Date().toISOString().slice(0, 7), appends: 7, totalLeaves: 7, liveTokens: 1 }]);
    for (const f of ["log.jsonl", "head.json", "keys.json", "checkpoints.json", "usage.json", "export.json"]) expect(existsSync(join(out, f)), f).toBe(true);
    // the exported log file is a copy the verifier reads: same size, same root as the head it was exported under
    const copy = new MerkleLog(join(out, "log.jsonl"));
    expect(copy.size).toBe(7);
    expect(copy.root()).toBe(r.rootHash);
    expect(JSON.parse(readFileSync(join(out, "head.json"), "utf8")).treeHead.payloadType).toMatch(/treehead/);
    expect(formatExport(r)).toMatch(/RESULT: EXPORT VERIFIED/);
  });

  it("another tenant's token, or none, gets nothing; and the export names what does not add up rather than hiding it", async () => {
    const out = mkdtempSync(join(tmpdir(), "export-bad-"));
    await expect(exportLog({ logUrl: log.url, tenant: "acme", token: otherToken, outDir: out })).rejects.toThrow(/refused the token/);
    expect((await fetch(`${log.url}t/acme/leaves`)).status).toBe(401);
    expect((await fetch(`${log.url}t/acme/usage`)).status).toBe(401);
    // a server that hands back the wrong leaves: the root will not match the signed head
    const lying: typeof fetch = async (url, init) => {
      const res = await fetch(url, init);
      if (!String(url).includes("/leaves")) return res;
      const body = (await res.json()) as { since: number; size: number; leaves: string[] };
      body.leaves = body.leaves.map(() => "00".repeat(32));
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    };
    const r = await exportLog({ logUrl: log.url, tenant: "acme", token: acmeToken, outDir: out, fetch: lying, months: [] });
    expect(r.problems.join("\n")).toMatch(/is not the head's/);
    expect(formatExport(r)).toMatch(/EXPORT DOES NOT ADD UP/);
  });

  it("the leaves route validates its window and caps the page", async () => {
    const h = { authorization: `Bearer ${acmeToken}` };
    expect((await fetch(`${log.url}t/acme/leaves?since=99`, { headers: h })).status).toBe(400);
    expect((await fetch(`${log.url}t/acme/leaves?limit=20000`, { headers: h })).status).toBe(400);
    const page = (await (await fetch(`${log.url}t/acme/leaves?since=5&limit=10`, { headers: h })).json()) as { since: number; size: number; leaves: string[] };
    expect(page).toMatchObject({ since: 5, size: 7 });
    expect(page.leaves).toHaveLength(2);
    expect((await fetch(`${log.url}t/acme/usage?month=2026-13`, { headers: h })).status).toBe(400);
  });
});

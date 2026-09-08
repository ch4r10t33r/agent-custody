// The probe is the alert. It must pass on a healthy log with a witness, and fail for exactly the reason things go
// wrong: a checkpoint that stopped following the head, a witness that stopped countersigning or raised an alarm,
// a head that does not verify. Everything runs in-process.
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { dirCheckpoints } from "../src/checkpoints.ts";
import { generateKeyPair, loadPrivateKey, writeKeyPair } from "../src/crypto.ts";
import { checkLog, formatLogCheck } from "../src/log-check.ts";
import { CheckpointPublisher, fileResolver, serveLog, type RunningLog } from "../src/log-sink.ts";
import { PostgresTenancy } from "../src/log-store.ts";
import { localSigner } from "../src/signer.ts";
import { Witness } from "../src/witness.ts";

function staticHost(dir: string): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const file = join(dir, decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
    if (!existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/` })));
}

const failing = (r: { checks: { name: string; ok: boolean; tenant: string | null }[] }) => r.checks.filter((c) => !c.ok).map((c) => c.name);

describe("log-check", () => {
  let dir: string;
  let log: RunningLog;
  let cpHost: { server: Server; url: string };
  let wHost: { server: Server; url: string };
  let publisher: CheckpointPublisher;
  let witness: Witness;
  const post = (leaf: string) => fetch(new URL("append", log.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leaf }) });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "logcheck-"));
    const logKp = writeKeyPair(generateKeyPair(), join(dir, "keys"), "log");
    const wKp = writeKeyPair(generateKeyPair(), join(dir, "keys"), "witness");
    const signer = localSigner(loadPrivateKey(logKp.keyFile));
    const store = dirCheckpoints(join(dir, "checkpoints"));
    const resolver = fileResolver(join(dir, "log.jsonl"), { logId: "probed" });
    log = await serveLog(resolver, signer, { port: 0, checkpoints: store });
    publisher = new CheckpointPublisher(resolver, signer, store, 60_000);
    cpHost = await staticHost(join(dir, "checkpoints"));
    witness = new Witness({ logUrl: log.url, checkpointsUrl: cpHost.url, tenants: ["default"], key: loadPrivateKey(wKp.keyFile), outDir: join(dir, "witnessed"), warn: () => {} });
    wHost = await staticHost(join(dir, "witnessed"));
  });
  afterAll(async () => {
    await log.close();
    cpHost.server.close();
    wHost.server.close();
  });

  it("passes on a healthy log whose checkpoint and witness are current, and /health answers", async () => {
    await post("a");
    await publisher.publishOnce();
    await witness.runOnce();
    const r = await checkLog({ logUrl: log.url, checkpointsUrl: cpHost.url, witnessUrl: wHost.url });
    expect(failing(r)).toEqual([]);
    expect(r.checks.map((c) => c.name)).toEqual(["key document served", "witness key document served", "head verifies against the published keys", "latest checkpoint verifies", "checkpoint keeps up with the head", "head extends the checkpoint", "witness has countersigned", "witness keeps up with the checkpoints", "witness has raised no alarm"]);
    expect(formatLogCheck(r)).toMatch(/RESULT: LOG HEALTHY/);
    const health = await (await fetch(new URL("health", log.url))).json();
    expect(health).toMatchObject({ ok: true, checkpoints: true });
  });

  it("fails when the checkpoint stops following the head for longer than the allowed lag, and passes again once it catches up", async () => {
    await post("b");
    const late = await checkLog({ logUrl: log.url, checkpointsUrl: cpHost.url, maxLagMs: 60_000, now: () => Date.now() + 120_000 });
    expect(failing(late)).toEqual(["checkpoint keeps up with the head"]);
    const soon = await checkLog({ logUrl: log.url, checkpointsUrl: cpHost.url, maxLagMs: 60_000 });
    expect(failing(soon)).toEqual([]); // the head moved seconds ago; the publisher has a minute
    await publisher.publishOnce();
    expect(failing(await checkLog({ logUrl: log.url, checkpointsUrl: cpHost.url, maxLagMs: 60_000, now: () => Date.now() + 120_000 }))).toEqual([]);
  });

  it("fails when the witness has fallen behind or raised an alarm, and when the log is unreachable", async () => {
    // the witness has not seen size 2 yet
    const behind = await checkLog({ logUrl: log.url, checkpointsUrl: cpHost.url, witnessUrl: wHost.url, maxLagMs: 1, now: () => Date.now() + 60_000 });
    expect(failing(behind)).toEqual(["witness keeps up with the checkpoints"]);
    await witness.runOnce();
    expect(failing(await checkLog({ logUrl: log.url, checkpointsUrl: cpHost.url, witnessUrl: wHost.url }))).toEqual([]);
    writeFileSync(join(dir, "witnessed", "default", "ALARM.json"), JSON.stringify({ reason: "test" }));
    expect(failing(await checkLog({ logUrl: log.url, checkpointsUrl: cpHost.url, witnessUrl: wHost.url }))).toEqual(["witness has raised no alarm"]);
    const dead = await checkLog({ logUrl: "http://127.0.0.1:1/" });
    expect(failing(dead)).toEqual(["key document served"]);
    expect(formatLogCheck(dead)).toMatch(/NEEDS ATTENTION/);
  });
});

describe("usage metering", () => {
  it("counts appends per tenant per month, total leaves, and live tokens", async () => {
    const db = new PGlite();
    try {
      await db.query("SELECT 1");
      const t = new PostgresTenancy(db);
      await t.addTenant("acme", "acme-eu");
      await t.addTenant("globex");
      await t.addToken("acme", "a");
      await t.addToken("acme", "b");
      const acme = await t.log("acme");
      for (let i = 0; i < 3; i++) await acme.appendHash("ab".repeat(32));
      await (await t.log("globex")).appendHash("cd".repeat(32));
      // move one of acme's leaves into last month
      await db.query("UPDATE log_leaves SET appended_at = now() - interval '35 days' WHERE tenant_id = 'acme' AND seq = 0");
      const month = new Date().toISOString().slice(0, 7);
      const u = await t.usage(month);
      expect(u.month).toBe(month);
      expect(u.tenants.map((x) => [x.id, x.appends, x.totalLeaves, x.liveTokens])).toEqual([["acme", 2, 3, 2], ["globex", 1, 1, 0]]);
      const last = new Date(Date.now() - 35 * 86_400_000).toISOString().slice(0, 7);
      expect((await t.usage(last)).tenants.map((x) => [x.id, x.appends])).toEqual([["acme", 1], ["globex", 0]]);
      await expect(t.usage("2026-13")).rejects.toThrow(/YYYY-MM/);
    } finally {
      await db.close();
    }
  });
});

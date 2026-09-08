// Phase 3 of the hosted log: the key lives in a signer process, the log publishes its keys where verifiers fetch
// them, and checkpoints let a verifier who was not watching prove later that nothing was rewritten.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { dirCheckpoints, postgresCheckpoints } from "../src/checkpoints.ts";
import { loadSdkConfig } from "../src/config.ts";
import { dsseVerify, generateKeyPair, loadPrivateKey, loadPublicKey, writeKeyPair, type Envelope } from "../src/crypto.ts";
import { CheckpointPublisher, fileResolver, postgresResolver, serveLog, type RunningLog } from "../src/log-sink.ts";
import { PostgresTenancy } from "../src/log-store.ts";
import { TREEHEAD_TYPE } from "../src/receipt.ts";
import { createSdkIssuer } from "../src/sdk/index.ts";
import { connectSigner, fetchLogKeys, localSigner, serveSigner, type RunningSigner } from "../src/signer.ts";
import { auditExtends, verifyBundle } from "../src/verify.ts";

const cli = join(import.meta.dirname, "..", "src", "cli.ts");
const run = (args: string[]) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
const failing = (r: { checks: { name: string; ok: boolean }[] }) => r.checks.filter((c) => !c.ok).map((c) => c.name);
const headOf = (env: Envelope) => JSON.parse(Buffer.from(env.payload, "base64").toString()) as { treeSize: number; rootHash: string; log?: string };

describe("the signer", () => {
  let dir: string;
  let signer: RunningSigner;
  let logKey: { keyFile: string; pubFile: string };
  let retired: { keyFile: string; pubFile: string };
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "signer-"));
    logKey = writeKeyPair(generateKeyPair(), join(dir, "keys"), "log");
    retired = writeKeyPair(generateKeyPair(), join(dir, "keys"), "old");
    signer = await serveSigner(loadPrivateKey(logKey.keyFile), { port: 0, token: "signer-secret", retired: [{ key: loadPublicKey(retired.pubFile), pem: readFileSync(retired.pubFile, "utf8"), validTo: "2026-09-01T00:00:00.000Z" }] });
  });
  afterAll(() => signer.close());

  it("signs only with the shared secret, lists the current and retired keys, and a remote signer is the same as a local one to a verifier", async () => {
    const no = await fetch(new URL("sign", signer.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payloadType: TREEHEAD_TYPE, payload: { treeSize: 1 } }) });
    expect(no.status).toBe(401);
    const doc = (await (await fetch(new URL("keys", signer.url))).json()) as { keys: { keyid: string; alg: string; validTo?: string }[] };
    expect(doc.keys.map((k) => k.keyid)).toEqual([loadPublicKey(logKey.pubFile).keyid, loadPublicKey(retired.pubFile).keyid]);
    expect(doc.keys[1]?.validTo).toBe("2026-09-01T00:00:00.000Z");
    await expect(connectSigner(signer.url)).resolves.toBeDefined(); // keys are public
    const remote = await connectSigner(signer.url, { token: "signer-secret" });
    expect(remote.keyid).toBe(signer.keyid);
    const env = await remote.sign(TREEHEAD_TYPE, { treeSize: 3, rootHash: "ab", timestamp: "t" });
    const v = dsseVerify(env, [loadPublicKey(logKey.pubFile)]);
    expect(v.ok && v.keyid).toBe(signer.keyid);
    const bad = await connectSigner(signer.url, { token: "wrong" });
    await expect(bad.sign(TREEHEAD_TYPE, {})).rejects.toThrow(/401/);
    const local = localSigner(loadPrivateKey(logKey.keyFile));
    expect((await local.keys()).keys[0]?.keyid).toBe(remote.keyid);
  });

  it("a log server that signs through the signer never holds the key, serves the key document, and its heads verify against fetched keys", async () => {
    const remote = await connectSigner(signer.url, { token: "signer-secret" });
    const log = await serveLog(join(dir, "log.jsonl"), remote, { port: 0, logId: "signed-log" });
    try {
      process.env.TEST_SIGNER_LOG = "unused";
      writeKeyPair(generateKeyPair(), join(dir, "app"), "app");
      writeFileSync(join(dir, "sdk.json"), JSON.stringify({ agentId: "bot", identity: { keyFile: "app/app.key" }, receiptsDir: "receipts", log: { url: log.url, hashOnly: true } }));
      const issuer = createSdkIssuer(loadSdkConfig(join(dir, "sdk.json")));
      const bundle = await issuer.record({ tool: "t", args: { n: 1 } }, { status: "executed", result: null });
      expect(headOf(bundle.treeHead)).toMatchObject({ treeSize: 1, log: "signed-log" });
      const { doc, keys } = await fetchLogKeys(log.url);
      expect(doc.log).toBe("signed-log");
      expect(keys.map((k) => k.keyid)).toEqual([signer.keyid, loadPublicKey(retired.pubFile).keyid]);
      const r = verifyBundle(bundle, { issuerKeys: [loadPublicKey(join(dir, "app", "app.pub"))], principalKeys: [], logKeys: keys, logId: "signed-log" });
      expect(failing(r)).toEqual([]);
      // the CLI does the same with --log-url and no key file for the log
      writeFileSync(join(dir, "bundle.json"), JSON.stringify(bundle));
      // spawned asynchronously: the log it fetches keys from is hosted in this process, so a synchronous spawn would deadlock
      const out = await run([cli, "verify", join(dir, "bundle.json"), "--issuer-key", join(dir, "app", "app.pub"), "--log-url", log.url, "--log-id", "signed-log"]);
      expect(out.status, out.stdout + out.stderr).toBe(0);
      expect(out.stdout).toMatch(/tree head signature\s+\(log key/);
      expect(out.stdout).toMatch(/RESULT: VERIFIED/);
    } finally {
      await log.close();
    }
  });
});

describe("checkpoints", () => {
  it("the publisher writes one signed head per grown log to the directory, the API lists them, and an audit between two checkpoints passes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "checkpoints-"));
    const kp = writeKeyPair(generateKeyPair(), join(dir, "keys"), "log");
    const signer = localSigner(loadPrivateKey(kp.keyFile));
    const store = dirCheckpoints(join(dir, "checkpoints"));
    const resolver = fileResolver(join(dir, "log.jsonl"), { logId: "cp-log", tenants: { acme: { file: join(dir, "acme.jsonl") } } });
    const log = await serveLog(resolver, signer, { port: 0, checkpoints: store });
    const publisher = new CheckpointPublisher(resolver, signer, store, 60_000);
    try {
      expect(await publisher.publishOnce()).toEqual([]); // nothing has grown
      const post = (path: string, leaf: string) => fetch(new URL(path, log.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leaf }) });
      await post("append", "a");
      await post("append", "b");
      const first = await publisher.publishOnce();
      expect(first.map((c) => [c.tenant, c.treeSize, c.logId])).toEqual([["default", 2, "cp-log"]]);
      expect(readdirSync(join(dir, "checkpoints", "default")).sort()).toEqual(["2.json", "latest.json"]);
      expect(await publisher.publishOnce()).toEqual([]); // unchanged since
      await post("append", "c");
      await post("t/acme/append", "x");
      const second = await publisher.publishOnce();
      expect(second.map((c) => [c.tenant, c.treeSize])).toEqual([["default", 3], ["acme", 1]]);
      const listed = (await (await fetch(new URL("checkpoints?since=2", log.url))).json()) as { checkpoints: { treeSize: number; treeHead: Envelope }[] };
      expect(listed.checkpoints.map((c) => c.treeSize)).toEqual([3]);
      const all = (await (await fetch(new URL("checkpoints", log.url))).json()) as { checkpoints: { treeSize: number; treeHead: Envelope }[] };
      expect(all.checkpoints.map((c) => c.treeSize)).toEqual([2, 3]);
      // a verifier who kept the size-2 checkpoint asks for the proof to size 3 and audits
      const proof = (await (await fetch(new URL("consistency?old=2&new=3", log.url))).json()) as { hashes: string[] };
      const audit = auditExtends(all.checkpoints[0]!.treeHead, all.checkpoints[1]!.treeHead, proof.hashes, [loadPublicKey(kp.pubFile)], "cp-log");
      expect(failing(audit)).toEqual([]);
      expect(headOf(all.checkpoints[1]!.treeHead).log).toBe("cp-log");
      // the acme checkpoint is under its own path and names no log id beyond its name
      const acme = (await (await fetch(new URL("t/acme/checkpoints", log.url))).json()) as { checkpoints: { treeSize: number }[] };
      expect(acme.checkpoints.map((c) => c.treeSize)).toEqual([1]);
    } finally {
      publisher.stop();
      await log.close();
    }
  });

  it("in Postgres the checkpoints are rows too, listed from the table", async () => {
    const db = new PGlite();
    try {
      await db.query("SELECT 1"); // engine load, paid up front
      const tenancy = new PostgresTenancy(db);
      await tenancy.addTenant("default", "pg-log");
      const tok = (await tenancy.addToken("default", "t")).token;
      const kp = generateKeyPair();
      const signer = localSigner(kp);
      const store = postgresCheckpoints(db);
      const resolver = postgresResolver(tenancy);
      const log = await serveLog(resolver, signer, { port: 0, checkpoints: store });
      try {
        await fetch(new URL("append", log.url), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify({ leafHash: "ab".repeat(32) }) });
        const publisher = new CheckpointPublisher(resolver, signer, store, 60_000);
        expect((await publisher.publishOnce()).map((c) => c.treeSize)).toEqual([1]);
        const rows = (await db.query("SELECT tenant_id, tree_size, log_id FROM log_heads")).rows;
        expect(rows).toEqual([{ tenant_id: "default", tree_size: 1, log_id: "pg-log" }]);
        const listed = (await (await fetch(new URL("checkpoints", log.url))).json()) as { checkpoints: { treeSize: number; rootHash: string }[] };
        expect(listed.checkpoints).toHaveLength(1);
        expect(listed.checkpoints[0]!.rootHash).toBe(await (await resolver.resolve(null))!.backend.root(1));
        expect(await store.latest("default")).toMatchObject({ treeSize: 1, logId: "pg-log" });
        // a second store that missed the write is caught up on the next publication, because `latest` follows the store furthest behind
        const { bothCheckpoints, dirCheckpoints } = await import("../src/checkpoints.ts");
        const lagging = dirCheckpoints(mkdtempSync(join(tmpdir(), "lagging-")));
        const both = bothCheckpoints(store, lagging);
        expect(await both.latest("default")).toBeNull();
        const again = new CheckpointPublisher(resolver, signer, both, 60_000);
        expect((await again.publishOnce()).map((c) => c.treeSize)).toEqual([1]);
        expect((await lagging.latest("default"))?.treeSize).toBe(1);
        expect(await again.publishOnce()).toEqual([]);
      } finally {
        await log.close();
      }
    } finally {
      await db.close();
    }
  }, 30_000);
});

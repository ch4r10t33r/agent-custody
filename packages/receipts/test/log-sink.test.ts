// A remote log exists so the operator cannot rewrite history. These tests pin what that buys and what it costs.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSdkConfig } from "../src/config.ts";
import { generateKeyPair, loadPrivateKey, loadPublicKey, writeKeyPair } from "../src/crypto.ts";
import { httpLog, serveLog, type RunningLog } from "../src/log-sink.ts";
import { createSdkIssuer } from "../src/sdk/index.ts";
import { auditExtends, verifyBundle } from "../src/verify.ts";

const failing = (r: ReturnType<typeof verifyBundle>) => r.checks.filter((c) => !c.ok).map((c) => c.name);
const failingAudit = (r: ReturnType<typeof auditExtends>) => r.checks.filter((c) => !c.ok).map((c) => c.name);

describe("HTTP log sink", () => {
  let dir: string;
  let log: RunningLog;
  let logPub: string;
  let appPub: string;
  let serverLogFile: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "log-sink-"));
    const logKey = writeKeyPair(generateKeyPair(), join(dir, "log-keys"), "log");
    logPub = logKey.pubFile;
    serverLogFile = join(dir, "server-log.jsonl");
    log = await serveLog(serverLogFile, loadPrivateKey(logKey.keyFile), { port: 0, tokens: ["s3cret"] });
    appPub = writeKeyPair(generateKeyPair(), join(dir, "keys"), "app").pubFile;
    process.env.TEST_LOG_TOKEN = "s3cret";
    writeFileSync(join(dir, "sdk.json"), JSON.stringify({ agentId: "bot", identity: { keyFile: "keys/app.key" }, receiptsDir: "receipts", log: { url: log.url, tokenEnv: "TEST_LOG_TOKEN" } }));
  });
  afterAll(async () => {
    await log.close();
    delete process.env.TEST_LOG_TOKEN;
  });

  it("tree heads are signed by the log's key, so a verifier needs that key and learns who runs the log", async () => {
    const issuer = createSdkIssuer(loadSdkConfig(join(dir, "sdk.json")));
    const bundle = await issuer.record({ tool: "crm.lookup", args: { id: "c1" } }, { status: "executed", result: { plan: "pro" } });
    const withLogKey = verifyBundle(bundle, { issuerKeys: [loadPublicKey(appPub)], principalKeys: [], logKeys: [loadPublicKey(logPub)], logFile: serverLogFile });
    expect(failing(withLogKey)).toEqual([]);
    expect(withLogKey.checks.find((c) => c.name === "tree head signature")?.detail).toMatch(/^log key /);
    const issuerOnly = verifyBundle(bundle, { issuerKeys: [loadPublicKey(appPub)], principalKeys: [] });
    expect(failing(issuerOnly)).toEqual(["tree head signature"]);
  });

  it("the log's own file and root endpoint agree with the tree head the issuer received", async () => {
    const issuer = createSdkIssuer(loadSdkConfig(join(dir, "sdk.json")));
    const bundle = await issuer.record({ tool: "crm.lookup", args: { id: "c2" } }, { status: "executed", result: null });
    const head = JSON.parse(Buffer.from(bundle.treeHead.payload, "base64").toString()) as { treeSize: number; rootHash: string };
    const remote = (await (await fetch(new URL(`root?size=${head.treeSize}`, log.url))).json()) as { rootHash: string };
    expect(remote.rootHash).toBe(head.rootHash);
    expect(readFileSync(serverLogFile, "utf8").trim().split("\n")).toHaveLength(head.treeSize);
  });

  it("an auditor holding two receipts asks the log for a consistency proof and learns nothing was rewritten between them", async () => {
    const issuer = createSdkIssuer(loadSdkConfig(join(dir, "sdk.json")));
    const older = await issuer.record({ tool: "t", args: { n: 1 } }, { status: "executed", result: null });
    await issuer.record({ tool: "t", args: { n: 2 } }, { status: "executed", result: null });
    const newer = await issuer.record({ tool: "t", args: { n: 3 } }, { status: "executed", result: null });
    const size = (b: typeof older) => (JSON.parse(Buffer.from(b.treeHead.payload, "base64").toString()) as { treeSize: number }).treeSize;
    const proof = (await (await fetch(new URL(`consistency?old=${size(older)}&new=${size(newer)}`, log.url))).json()) as { hashes: string[] };
    const keys = [loadPublicKey(logPub)];
    expect(auditExtends(older.treeHead, newer.treeHead, proof.hashes, keys).ok).toBe(true);
    // the same proof against a tree head signed by someone else, or the wrong way round, does not pass
    expect(failingAudit(auditExtends(older.treeHead, newer.treeHead, proof.hashes, [loadPublicKey(appPub)]))).toContain("older tree head signature");
    expect(failingAudit(auditExtends(newer.treeHead, older.treeHead, proof.hashes, keys))).toEqual(["older is not larger than newer"]);
    const head = (await (await fetch(new URL("head", log.url))).json()) as { treeHead: typeof older.treeHead };
    expect(auditExtends(newer.treeHead, head.treeHead, [], keys).ok).toBe(true);
  });

  it("a wrong token is refused and no receipt is written", async () => {
    process.env.TEST_LOG_TOKEN_WRONG = "wrong";
    const issuer = createSdkIssuer({ agentId: "bot", identity: { keyFile: join(dir, "keys", "app.key") }, receiptsDir: join(dir, "bad-receipts"), log: { url: log.url, tokenEnv: "TEST_LOG_TOKEN_WRONG" } });
    await expect(issuer.record({ tool: "t", args: {} }, { status: "executed", result: 1 })).rejects.toThrow(/401/);
  });

  it("the sink surfaces a malformed log reply instead of writing a bundle around it", async () => {
    const sink = httpLog("http://log.invalid/", { fetch: async () => new Response(JSON.stringify({ nonsense: true }), { status: 200 }) });
    await expect(sink.append("leaf")).rejects.toThrow(/malformed/);
  });

  it("config demands exactly one of logFile and log", () => {
    const both = join(dir, "both.json");
    writeFileSync(both, JSON.stringify({ agentId: "bot", identity: { keyFile: "keys/app.key" }, receiptsDir: "r", logFile: "l.jsonl", log: { url: "http://x/" } }));
    expect(() => loadSdkConfig(both)).toThrow(/exactly one of logFile or log/);
    const neither = join(dir, "neither.json");
    writeFileSync(neither, JSON.stringify({ agentId: "bot", identity: { keyFile: "keys/app.key" }, receiptsDir: "r" }));
    expect(() => loadSdkConfig(neither)).toThrow(/exactly one of logFile or log/);
  });

  it("a missing token variable fails at startup, not at the first receipt", () => {
    expect(() => createSdkIssuer({ agentId: "bot", identity: { keyFile: join(dir, "keys", "app.key") }, receiptsDir: join(dir, "r"), log: { url: log.url, tokenEnv: "NOT_SET_ANYWHERE" } })).toThrow(/NOT_SET_ANYWHERE/);
  });
});

describe("a log run for someone else: hash-only leaves, tenants, and log ids", () => {
  let dir: string;
  let log: RunningLog;
  let logKey: { keyFile: string; pubFile: string };
  let appPub: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "log-tenants-"));
    logKey = writeKeyPair(generateKeyPair(), join(dir, "log-keys"), "log");
    appPub = writeKeyPair(generateKeyPair(), join(dir, "keys"), "app").pubFile;
    log = await serveLog(join(dir, "default.jsonl"), loadPrivateKey(logKey.keyFile), {
      port: 0,
      logId: "default",
      tenants: { acme: { file: join(dir, "acme.jsonl"), tokens: ["acme-token"] }, globex: { file: join(dir, "globex.jsonl"), tokens: ["globex-token"], logId: "globex-eu" } },
    });
    process.env.TEST_ACME_TOKEN = "acme-token";
  });
  afterAll(async () => {
    await log.close();
    delete process.env.TEST_ACME_TOKEN;
  });

  it("with hashOnly the log never sees the receipt: the file holds hashes, and the receipt still verifies against the log's head", async () => {
    writeFileSync(join(dir, "sdk.json"), JSON.stringify({ agentId: "bot", identity: { keyFile: "keys/app.key" }, receiptsDir: "receipts", log: { url: new URL("t/acme/", log.url).toString(), tokenEnv: "TEST_ACME_TOKEN", hashOnly: true } }));
    const issuer = createSdkIssuer(loadSdkConfig(join(dir, "sdk.json")));
    const bundle = await issuer.record({ tool: "crm.lookup", args: { ssn: "SSN-111-22-3333" } }, { status: "executed", result: { plan: "pro" } });
    const file = readFileSync(join(dir, "acme.jsonl"), "utf8");
    expect(file).not.toContain("SSN-111-22-3333");
    expect(file).not.toContain("payloadType");
    expect(JSON.parse(file.trim().split("\n")[0]!)).toEqual({ hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const keys = { issuerKeys: [loadPublicKey(appPub)], principalKeys: [], logKeys: [loadPublicKey(logKey.pubFile)] };
    expect(failing(verifyBundle(bundle, { ...keys, logFile: join(dir, "acme.jsonl") }))).toEqual([]);
    // the tree head names the tenant's log; a verifier told which log to expect checks it
    expect(failing(verifyBundle(bundle, { ...keys, logId: "acme" }))).toEqual([]);
    const wrong = verifyBundle(bundle, { ...keys, logId: "globex-eu" });
    expect(failing(wrong)).toEqual(["tree head names the expected log"]);
    expect(wrong.checks.find((c) => c.name === "tree head names the expected log")?.detail).toBe("log acme");
  });

  it("tenants are separate logs with separate tokens and ids, and the default log stays at the root paths", async () => {
    const post = (path: string, token: string | null, body: unknown) => fetch(new URL(path, log.url), { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    expect((await post("t/globex/append", "acme-token", { leaf: "x" })).status).toBe(401);
    const g = await post("t/globex/append", "globex-token", { leafHash: "ab".repeat(32) });
    expect(g.status).toBe(200);
    const head = JSON.parse(Buffer.from(((await g.json()) as { treeHead: { payload: string } }).treeHead.payload, "base64").toString()) as { log?: string; treeSize: number };
    expect(head).toMatchObject({ log: "globex-eu", treeSize: 1 });
    expect((await post("t/nobody/append", null, { leaf: "x" })).status).toBe(404);
    expect((await post("t/acme/append", "acme-token", { leafHash: "not-hex" })).status).toBe(400);
    const d = await post("append", null, { leaf: "open default log" });
    expect(d.status).toBe(200);
    const dhead = JSON.parse(Buffer.from(((await d.json()) as { treeHead: { payload: string } }).treeHead.payload, "base64").toString()) as { log?: string };
    expect(dhead.log).toBe("default");
    const roots = await Promise.all(["t/acme/root", "t/globex/root", "root"].map(async (p) => ((await (await fetch(new URL(p, log.url))).json()) as { treeSize: number }).treeSize));
    expect(roots).toEqual([1, 1, 1]);
  });

  it("audit refuses to compare heads from different logs, and checks the expected log when told one", async () => {
    const issuer = createSdkIssuer(loadSdkConfig(join(dir, "sdk.json")));
    const older = await issuer.record({ tool: "t", args: { n: 1 } }, { status: "executed", result: null });
    const newer = await issuer.record({ tool: "t", args: { n: 2 } }, { status: "executed", result: null });
    const proof = (await (await fetch(new URL(`t/acme/consistency?old=${older.inclusion.treeSize}&new=${newer.inclusion.treeSize}`, log.url))).json()) as { hashes: string[] };
    const keys = [loadPublicKey(logKey.pubFile)];
    expect(failingAudit(auditExtends(older.treeHead, newer.treeHead, proof.hashes, keys))).toEqual([]);
    expect(failingAudit(auditExtends(older.treeHead, newer.treeHead, proof.hashes, keys, "acme"))).toEqual([]);
    expect(failingAudit(auditExtends(older.treeHead, newer.treeHead, proof.hashes, keys, "globex-eu"))).toEqual(["both tree heads name the expected log"]);
    const globexHead = ((await (await fetch(new URL("t/globex/head", log.url))).json()) as { treeHead: import("../src/crypto.ts").Envelope }).treeHead;
    expect(failingAudit(auditExtends(older.treeHead, globexHead, [], keys))).toContain("both tree heads name the same log");
  });
});

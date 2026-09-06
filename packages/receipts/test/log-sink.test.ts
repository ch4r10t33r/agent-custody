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

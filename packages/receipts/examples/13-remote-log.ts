// Aspect: a log run by someone else. Source: src/log-sink.ts, src/verify.ts
// Run:    node examples/13-remote-log.ts
// The local log is tamper-evident but the operator holds the file. A remote log signs tree heads with its own key,
// so a verifier who trusts that key knows the receipt was in a log the operator could not rewrite.
import { join } from "node:path";
import { generateKeyPair, loadPrivateKey, loadPublicKey, writeKeyPair } from "../src/crypto.ts";
import { serveLog } from "../src/log-sink.ts";
import { createSdkIssuer } from "../src/sdk/index.ts";
import { verifyBundle } from "../src/verify.ts";
import { out } from "./_out.ts";

const dir = out("13-remote-log");
const step = (n: number, s: string) => console.log(`\n${n}. ${s}`);

step(1, "the log operator has a key of their own; the reference server runs in-process here, on a free port");
const logKey = writeKeyPair(generateKeyPair(), join(dir, "log-keys"), "log");
const log = await serveLog(join(dir, "server-log.jsonl"), loadPrivateKey(logKey.keyFile), { port: 0, tokens: ["demo-token"] });
console.log("   log at", log.url, "keyid", loadPublicKey(logKey.pubFile).keyid.slice(0, 12));

step(2, "the agent's SDK config names the log instead of a file; the token comes from an environment variable");
process.env.DEMO_LOG_TOKEN = "demo-token";
const app = writeKeyPair(generateKeyPair(), join(dir, "keys"), "app");
const issuer = createSdkIssuer({ agentId: "billing-bot", identity: { keyFile: app.keyFile }, receiptsDir: join(dir, "receipts"), log: { url: log.url, tokenEnv: "DEMO_LOG_TOKEN" } });
console.log("   issuer logs to", issuer.log.kind, issuer.log.where);

step(3, "issuing a receipt appends the leaf remotely; the tree head comes back signed by the log's key");
const bundle = await issuer.record({ tool: "stripe.refund", args: { amount: 1200 } }, { status: "executed", result: { ok: true } });
console.log("   tree head signed by keyid", bundle.treeHead.signatures[0]!.keyid.slice(0, 12));

step(4, "verifying with the issuer key alone fails on the tree head; adding the log key passes");
const alone = verifyBundle(bundle, { issuerKeys: [loadPublicKey(app.pubFile)], principalKeys: [] });
console.log("   issuer key only:", alone.ok, "->", alone.checks.filter((c) => !c.ok).map((c) => c.name).join(", "));
const both = verifyBundle(bundle, { issuerKeys: [loadPublicKey(app.pubFile)], principalKeys: [], logKeys: [loadPublicKey(logKey.pubFile)] });
console.log("   with the log key:", both.ok, "->", both.checks.find((c) => c.name === "tree head signature")?.detail);

step(5, "an auditor asks the log for its root at that size and compares it with the tree head");
const head = JSON.parse(Buffer.from(bundle.treeHead.payload, "base64").toString()) as { treeSize: number; rootHash: string };
const remote = (await (await fetch(new URL(`root?size=${head.treeSize}`, log.url))).json()) as { rootHash: string };
console.log("   remote root matches:", remote.rootHash === head.rootHash);

step(6, "the wrong token gets nothing appended and no receipt written");
process.env.WRONG_TOKEN = "nope";
const intruder = createSdkIssuer({ agentId: "x", identity: { keyFile: app.keyFile }, receiptsDir: join(dir, "intruder"), log: { url: log.url, tokenEnv: "WRONG_TOKEN" } });
await intruder.record({ tool: "t", args: {} }, { status: "executed", result: null }).catch((e: Error) => console.log("   refused:", e.message.split(":")[1]?.trim()));

await log.close();
if (alone.ok || !both.ok || remote.rootHash !== head.rootHash) throw new Error("unexpected");
console.log("\nOK");

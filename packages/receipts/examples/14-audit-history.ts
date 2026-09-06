// Aspect: proving a log was not rewritten. Source: src/log.ts (consistency proofs), src/verify.ts (auditExtends)
// Run:    node examples/14-audit-history.ts
// An inclusion proof says a receipt is in the log at one moment. A consistency proof says the log at a later moment
// still contains everything it contained earlier. Keep the tree head from any receipt; later, ask for the proof.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPair, loadPublicKey, writeKeyPair } from "../src/crypto.ts";
import { MerkleLog } from "../src/log.ts";
import { createSdkIssuer } from "../src/sdk/index.ts";
import { auditExtends } from "../src/verify.ts";
import { out } from "./_out.ts";

const dir = out("14-audit-history");
const step = (n: number, s: string) => console.log(`\n${n}. ${s}`);
const size = (env: { payload: string }) => (JSON.parse(Buffer.from(env.payload, "base64").toString()) as { treeSize: number }).treeSize;

step(1, "an SDK issuer with a local log records three calls; the auditor keeps the tree head from the first receipt");
const app = writeKeyPair(generateKeyPair(), join(dir, "keys"), "app");
const logFile = join(dir, "log.jsonl");
const issuer = createSdkIssuer({ agentId: "billing-bot", identity: { keyFile: app.keyFile }, receiptsDir: join(dir, "receipts"), logFile });
const first = await issuer.record({ tool: "stripe.refund", args: { amount: 100 } }, { status: "executed", result: { ok: true } });
await issuer.record({ tool: "stripe.refund", args: { amount: 200 } }, { status: "executed", result: { ok: true } });
const third = await issuer.record({ tool: "stripe.refund", args: { amount: 300 } }, { status: "executed", result: { ok: true } });
console.log(`   kept tree head at size ${size(first.treeHead)}; newest receipt is at size ${size(third.treeHead)}`);

step(2, "later, with a copy of the log, the auditor computes the consistency proof and checks the newest head extends the kept one");
const keys = [loadPublicKey(app.pubFile)];
const honest = auditExtends(first.treeHead, third.treeHead, new MerkleLog(logFile).consistencyProof(size(first.treeHead), size(third.treeHead)), keys);
for (const c of honest.checks) console.log(`   ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);

step(3, "the operator quietly rewrites the first receipt's leaf in the log file, then appends a fourth call as if nothing happened");
const lines = readFileSync(logFile, "utf8").trim().split("\n");
lines[0] = JSON.stringify((JSON.parse(lines[0]!) as string).replace(/"payload":"(.)/, (_m, c: string) => `"payload":"${c === "A" ? "B" : "A"}`));   // one character of the first leaf
writeFileSync(logFile, lines.join("\n") + "\n");
const rewritten = createSdkIssuer({ agentId: "billing-bot", identity: { keyFile: app.keyFile }, receiptsDir: join(dir, "receipts"), logFile });
const fourth = await rewritten.record({ tool: "stripe.refund", args: { amount: 400 } }, { status: "executed", result: { ok: true } });

step(4, "the fourth receipt verifies on its own, but its tree head does not extend the one the auditor kept");
const tampered = auditExtends(first.treeHead, fourth.treeHead, new MerkleLog(logFile).consistencyProof(size(first.treeHead), size(fourth.treeHead)), keys);
for (const c of tampered.checks) console.log(`   ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
console.log("   with a remote log the auditor asks GET /consistency?old=M&new=N instead of holding a copy; example 13 has the server");

if (!honest.ok || tampered.ok) throw new Error("unexpected");
console.log("\nOK");

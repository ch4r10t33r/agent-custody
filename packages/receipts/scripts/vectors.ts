// Generates the conformance vectors in vectors/. Run with `bun run vectors`; commit the result.
// The vectors are a snapshot: keys, receipts, logs, and expected verdicts produced by this implementation, so that a
// verifier written elsewhere can prove it agrees. Regenerate only when the format changes, never to make a test pass.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize, digestOf, dsseSign, generateKeyPair, loadPrivateKey, loadPublicKey, sha256Hex, type Envelope, type KeyPair } from "../src/crypto.ts";
import { createGateway, RECEIPT_META_KEY } from "../src/gateway.ts";
import { loadConfig, loadSdkConfig } from "../src/config.ts";
import { consistencyProof, inclusionProof, leafHash, rootOf } from "../src/log.ts";
import { serveLog } from "../src/log-sink.ts";
import { RECEIPT_TYPE, type ReceiptBundle, type ReceiptStatement } from "../src/receipt.ts";
import { createSdkIssuer } from "../src/sdk/index.ts";
import { verifyBundle, type VerifyOptions } from "../src/verify.ts";
import { buildFixture, buildSdkFixture } from "./fixture.ts";

const out = join(import.meta.dirname, "..", "vectors");
const decode = (b: ReceiptBundle) => JSON.parse(Buffer.from(b.envelope.payload, "base64").toString()) as ReceiptStatement;
const bundleFile = (dir: string, id: string) => JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as ReceiptBundle;
const logLines = (file: string) => readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string);

interface Case {
  name: string;
  description: string;
  bundle: ReceiptBundle;
  issuerKeys: string[];
  principalKeys: string[];
  logKeys: string[];
  log: string[] | null;
  expected: { ok: boolean; failing: string[] };
}

const keys: Record<string, { publicKeyPem: string; keyid: string }> = {};
const pems: Record<string, string> = {};
function key(name: string, pubFile: string) {
  const pem = readFileSync(pubFile, "utf8");
  pems[name] = pem;
  keys[name] = { publicKeyPem: pem, keyid: loadPublicKey(pubFile).keyid };
}

/** Re-sign a statement whose predicate was edited, with the issuer's key, keeping the original tree head and proof. */
function resigned(bundle: ReceiptBundle, issuer: KeyPair, edit: (st: ReceiptStatement) => void): ReceiptBundle {
  const st = decode(bundle);
  edit(st);
  return { ...bundle, envelope: dsseSign(RECEIPT_TYPE, st, issuer) };
}

const cases: Case[] = [];
function addCase(c: Omit<Case, "expected">, opts?: Partial<VerifyOptions>) {
  const tmp = mkdtempSync(join(tmpdir(), "vectors-"));
  const logFile = c.log ? join(tmp, "log.jsonl") : undefined;
  if (c.log && logFile) writeFileSync(logFile, c.log.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const r = verifyBundle(c.bundle, {
    issuerKeys: c.issuerKeys.map((k) => keyFrom(k)),
    principalKeys: c.principalKeys.map((k) => keyFrom(k)),
    logKeys: c.logKeys.map((k) => keyFrom(k)),
    ...(logFile ? { logFile } : {}),
    ...opts,
  });
  cases.push({ ...c, expected: { ok: r.ok, failing: r.checks.filter((x) => !x.ok).map((x) => x.name) } });
}
import { publicKeyFromPem } from "../src/crypto.ts";
const keyFrom = (name: string) => publicKeyFromPem(pems[name]!);

// ---- gateway receipts: executed, denied, and edited-then-resigned variants ----
const gfx = buildFixture(mkdtempSync(join(tmpdir(), "vectors-gateway-")));
key("gateway", gfx.gatewayPub);
key("principal", gfx.principalPub);
const gatewayKey = loadPrivateKey(join(gfx.dir, "keys", "gateway.key"));
const gw = await createGateway(loadConfig(gfx.configFile));
const ok = await gw.handleCall({ name: "stripe.refund", arguments: { customer_id: "cust_123", amount: 50000 }, _meta: { "agent-custody/model": "vector-model" } });
const denied = await gw.handleCall({ name: "stripe.refund", arguments: { customer_id: "cust_123", amount: 5000000 } });
await gw.close();
const executed = bundleFile(gfx.receiptsDir, String(ok._meta?.[RECEIPT_META_KEY]));
const deniedBundle = bundleFile(gfx.receiptsDir, String(denied._meta?.[RECEIPT_META_KEY]));
const glog = logLines(gfx.logFile);
const G = { issuerKeys: ["gateway"], principalKeys: ["principal"], logKeys: [] as string[] };

addCase({ name: "gateway-executed", description: "An in-policy refund through the gateway: delegation attested, facts observed, executed. Every check passes with the log.", bundle: executed, ...G, log: glog });
addCase({ name: "gateway-denied", description: "An over-limit refund denied by policy. The receipt exists, execution is denied, and every check passes.", bundle: deniedBundle, ...G, log: glog });
addCase({ name: "gateway-executed-no-log-copy", description: "The same executed receipt verified without a copy of the log: inclusion still proven against the signed tree head, the log-file check simply absent.", bundle: executed, ...G, log: null });
addCase({ name: "wrong-issuer-key", description: "Verified against the principal's key as if it were the issuer's. The signature check fails first and nothing else is decided.", bundle: executed, issuerKeys: ["principal"], principalKeys: ["principal"], logKeys: [], log: glog });
addCase({ name: "tampered-payload", description: "One character of the base64 payload changed. The signature no longer verifies.", bundle: { ...executed, envelope: { ...executed.envelope, payload: executed.envelope.payload.replace(/^(.)/, (c) => (c === "A" ? "B" : "A")) } }, ...G, log: glog });
addCase({ name: "resigned-tool-out-of-scope", description: "Predicate edited to name a tool outside the grant, then re-signed with the real gateway key. The signature passes; the scope check fails; the log no longer contains this leaf.", bundle: resigned(executed, gatewayKey, (st) => { st.predicate.tool.name = "stripe.payout"; st.subject[0]!.name = `tool-call:stripe.payout:${st.predicate.receiptId}`; }), ...G, log: glog });
addCase({ name: "resigned-policy-inconsistent", description: "Predicate edited so the policy says deny while execution says executed, re-signed with the gateway key.", bundle: resigned(executed, gatewayKey, (st) => { st.predicate.policy!.decision = "deny"; }), ...G, log: glog });
addCase({ name: "resigned-args-digest", description: "Request args edited without updating the digest, re-signed with the gateway key.", bundle: resigned(executed, gatewayKey, (st) => { (st.predicate.request.args as Record<string, unknown>).amount = 1; }), ...G, log: glog });
addCase({ name: "inclusion-proof-wrong-index", description: "The inclusion proof's leaf index changed. The tree head still verifies; the proof does not.", bundle: { ...executed, inclusion: { ...executed.inclusion, leafIndex: executed.inclusion.leafIndex + 1 } }, ...G, log: glog });
addCase({ name: "log-copy-from-another-log", description: "Verified against a copy of a different log. Everything passes except the recomputed root.", bundle: executed, ...G, log: ["not-the-same-leaf"] });

// ---- SDK receipts: self-reported, no delegation ----
const sfx = buildSdkFixture(mkdtempSync(join(tmpdir(), "vectors-sdk-")), undefined, "vectors");
key("app", sfx.appPub);
const sdk = createSdkIssuer(loadSdkConfig(sfx.configFile));
const sdkBundle = await sdk.record({ tool: "stripe.refund", args: { amount: 500 }, session: { id: "sess-1", toolUseId: "call-1" } }, { status: "executed", result: { refund_id: "re_1" } }, sdk.decide({ tool: "stripe.refund", args: { amount: 500 } }));
const sdkDenied = await sdk.record({ tool: "stripe.refund", args: { amount: 500000 } }, { status: "denied", reason: "over limit" }, sdk.decide({ tool: "stripe.refund", args: { amount: 500000 } }));
const slog = logLines(sfx.logFile);
addCase({ name: "sdk-executed", description: "A receipt from the in-process SDK: issuer kind sdk, principal claimed, no delegation, every field claimed. Passes; the report says what it is worth.", bundle: sdkBundle, issuerKeys: ["app"], principalKeys: [], logKeys: [], log: slog });
addCase({ name: "sdk-denied", description: "An SDK denial receipt: the wrapped function was never called.", bundle: sdkDenied, issuerKeys: ["app"], principalKeys: [], logKeys: [], log: slog });

// ---- remote log: tree heads signed by the log's key ----
const rdir = mkdtempSync(join(tmpdir(), "vectors-remote-"));
const logKp = generateKeyPair();
const { writeKeyPair } = await import("../src/crypto.ts");
const logFiles = writeKeyPair(logKp, join(rdir, "log-keys"), "log");
key("log", logFiles.pubFile);
const remote = await serveLog(join(rdir, "server-log.jsonl"), logKp, { port: 0 });
const remoteSdk = createSdkIssuer({ agentId: "remote-bot", identity: { keyFile: join(sfx.dir, "keys", "app.key") }, receiptsDir: join(rdir, "receipts"), log: { url: remote.url } });
const remoteBundle = await remoteSdk.record({ tool: "crm.lookup", args: { id: "acct:42" } }, { status: "executed", result: { plan: "pro" } });
await remoteSdk.record({ tool: "crm.lookup", args: { id: "acct:43" } }, { status: "executed", result: { plan: "free" } });
const remoteHeadLater = (await (await fetch(new URL("head", remote.url))).json()) as { treeHead: Envelope };
const remoteProof = (await (await fetch(new URL("consistency?old=1&new=2", remote.url))).json()) as { hashes: string[] };
const rlog = logLines(join(rdir, "server-log.jsonl"));
await remote.close();
addCase({ name: "remote-log-with-log-key", description: "Logged to a log run by someone else: the tree head is signed by the log's key. With that key trusted, everything passes and the report names the log key.", bundle: remoteBundle, issuerKeys: ["app"], principalKeys: [], logKeys: ["log"], log: rlog });
addCase({ name: "remote-log-without-log-key", description: "The same receipt with only the issuer key trusted. The tree head signature fails; nothing about inclusion can be decided.", bundle: remoteBundle, issuerKeys: ["app"], principalKeys: [], logKeys: [], log: rlog });

writeFileSync(join(out, "receipts.json"), JSON.stringify({ version: "0.2", generated: new Date().toISOString(), note: "Each case: verify `bundle` with the named keys (see `keys`) and, when `log` is not null, a copy of the log whose lines are these leaves. `expected.failing` lists the check names that must fail; `expected.ok` is true only when it is empty.", keys, cases }, null, 2) + "\n");

// ---- audit: consistency between two signed tree heads ----
const audit = {
  version: "0.2",
  note: "auditExtends(older, newer, proof, keys): both tree heads must verify against a listed key; the proof is the log's consistency proof between their sizes.",
  cases: [
    { name: "remote-log-extends", description: "The tree head from the first remote receipt and the log's later head, with the proof the log served.", older: remoteBundle.treeHead, newer: remoteHeadLater.treeHead, proof: remoteProof.hashes, keys: ["log"], expected: { ok: true, failing: [] } },
    { name: "remote-log-wrong-order", description: "The same heads the wrong way round.", older: remoteHeadLater.treeHead, newer: remoteBundle.treeHead, proof: remoteProof.hashes, keys: ["log"], expected: { ok: false, failing: ["older is not larger than newer"] } },
    { name: "remote-log-wrong-key", description: "Tree heads checked against the app key, which did not sign them.", older: remoteBundle.treeHead, newer: remoteHeadLater.treeHead, proof: remoteProof.hashes, keys: ["app"], expected: { ok: false, failing: ["older tree head signature", "newer tree head signature"] } },
    { name: "remote-log-bad-proof", description: "A proof with a hash removed.", older: remoteBundle.treeHead, newer: remoteHeadLater.treeHead, proof: remoteProof.hashes.slice(1), keys: ["log"], expected: { ok: false, failing: ["newer log extends older log"] } },
  ],
};
writeFileSync(join(out, "audit.json"), JSON.stringify(audit, null, 2) + "\n");

// ---- the log itself: RFC 6962 roots, RFC 9162 inclusion and consistency proofs ----
const leaves = Array.from({ length: 7 }, (_, i) => `leaf-${i}`);
const hashes = leaves.map(leafHash);
const merkle = {
  version: "0.2",
  note: "leafHash = sha256(0x00 || leaf); nodeHash = sha256(0x01 || left || right). Proof hashes are hex, leaf-to-root for inclusion; RFC 9162 order for consistency.",
  leaves,
  leafHashes: hashes.map((h) => h.toString("hex")),
  roots: Array.from({ length: 8 }, (_, n) => rootOf(hashes, n)),
  inclusion: leaves.map((_, i) => ({ leafIndex: i, treeSize: 7, hashes: inclusionProof(hashes, i, 7).hashes, root: rootOf(hashes, 7), expected: true })),
  consistency: [
    ...[[0, 7], [1, 7], [2, 5], [3, 7], [4, 7], [5, 6], [7, 7]].map(([m, n]) => ({ oldSize: m, newSize: n, oldRoot: rootOf(hashes, m!), newRoot: rootOf(hashes, n!), hashes: consistencyProof(hashes, m!, n!), expected: true })),
    { oldSize: 3, newSize: 7, oldRoot: rootOf(hashes, 3), newRoot: rootOf(hashes.map((h, i) => (i === 1 ? leafHash("leaf-1-edited") : h)), 7), hashes: consistencyProof(hashes.map((h, i) => (i === 1 ? leafHash("leaf-1-edited") : h)), 3, 7), expected: false, description: "leaf 1 rewritten after the older head was taken" },
  ],
};
writeFileSync(join(out, "merkle.json"), JSON.stringify(merkle, null, 2) + "\n");

// ---- canonical JSON, digests, keyids, and the DSSE pre-authentication encoding ----
const values: unknown[] = [{ b: 1, a: [3, { z: null, y: "ÿ" }], c: undefined }, "plain", 42, [1, 2, 3], { nested: { deep: { deeper: true } } }, {}];
const kp = generateKeyPair();
const env = dsseSign("application/vnd.example+json", { hello: "world" }, kp);
const canonical = {
  version: "0.2",
  note: "canonical JSON: keys sorted, no whitespace, undefined dropped. digest = hex sha256 of the canonical string. keyid = hex sha256 of the SPKI DER public key. DSSE PAE = 'DSSEv1 ' + len(type) + ' ' + type + ' ' + len(payload) + ' ' + payload, signed with Ed25519.",
  values: values.map((v) => ({ value: v ?? null, canonical: canonicalize(v), digest: digestOf(v) })),
  keyid: { publicKeyPem: kp.publicKey.export({ type: "spki", format: "pem" }), keyid: kp.keyid },
  dsse: { publicKeyPem: kp.publicKey.export({ type: "spki", format: "pem" }), envelope: env, payloadJson: canonicalize({ hello: "world" }), paeHex: Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(env.payloadType)} ${env.payloadType} ${Buffer.from(env.payload, "base64").length} `), Buffer.from(env.payload, "base64")]).toString("hex"), paeSha256: sha256Hex(Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(env.payloadType)} ${env.payloadType} ${Buffer.from(env.payload, "base64").length} `), Buffer.from(env.payload, "base64")])), expected: true },
};
writeFileSync(join(out, "canonical.json"), JSON.stringify(canonical, null, 2) + "\n");

console.log(`wrote ${cases.length} receipt cases, ${audit.cases.length} audit cases, merkle and canonical vectors to ${out}`);

// Aspect: identities and signatures. Source: src/crypto.ts
// Run:    node examples/01-keys-and-signing.ts
//
// Every party that signs anything, the gateway, an SDK application, a principal, is an Ed25519 key pair.
// Signatures use DSSE envelopes over canonical JSON, so the same object always produces the same bytes.
import { digestOf, dsseSign, dsseVerify, generateKeyPair, loadPrivateKey, loadPublicKey, writeKeyPair } from "../src/crypto.ts";
import { out, step } from "./_out.ts";

const dir = out("01-keys");

step(1, "generate a key pair and write it to disk (CLI equivalent: node src/cli.ts keygen --dir keys --name gateway)");
const kp = generateKeyPair();
const files = writeKeyPair(kp, dir, "gateway");
console.log("   keyid (sha256 of the SPKI public key):", kp.keyid);
console.log("   files:", files.keyFile, files.pubFile);

step(2, "reload the private key; the keyid is derived, so it matches");
console.log("   match:", loadPrivateKey(files.keyFile).keyid === kp.keyid);

step(3, "sign a payload into a DSSE envelope");
const envelope = dsseSign("application/vnd.example+json", { amount: 500, currency: "GBP" }, kp);
console.log("   payloadType:", envelope.payloadType);
console.log("   payload (base64):", envelope.payload);
console.log("   signature by keyid:", envelope.signatures[0]!.keyid.slice(0, 16) + "…");

step(4, "verify it with only the public key file, as an auditor would");
const verified = dsseVerify(envelope, [loadPublicKey(files.pubFile)]);
console.log("   ok:", verified.ok, verified.ok ? JSON.stringify(verified.payload) : verified.error);

step(5, "edit one byte of the payload and try again");
const tampered = { ...envelope, payload: Buffer.from(JSON.stringify({ amount: 5, currency: "GBP" })).toString("base64") };
const t = dsseVerify(tampered, [kp]);
console.log("   ok:", t.ok, t.ok ? "" : `(${t.error})`);

step(6, "digests do not depend on key order, so two parties computing them independently agree");
console.log("   equal:", digestOf({ a: 1, b: [2, { c: 3 }] }) === digestOf({ b: [2, { c: 3 }], a: 1 }));

console.log("\nOK");

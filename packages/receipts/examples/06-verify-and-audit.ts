// Aspect: verification and auditing. Source: src/verify.ts
// Run:    node examples/06-verify-and-audit.ts
//
// A verifier holds a receipt bundle and public keys. Nothing else. Optionally a copy of the log.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { loadPublicKey } from "../src/crypto.ts";
import { createGateway, RECEIPT_META_KEY } from "../src/gateway.ts";
import type { ReceiptBundle, ReceiptStatement } from "../src/receipt.ts";
import { formatReport, verifyBundle } from "../src/verify.ts";
import { buildFixture } from "../scripts/fixture.ts";
import { out, step } from "./_out.ts";

const fx = buildFixture(out("06-verify"));
const gw = await createGateway(loadConfig(fx.configFile));
const r = await gw.handleCall({ name: "stripe.refund", arguments: { customer_id: "cust_123", amount: 50000 } });
await gw.close();
const id = String(r._meta?.[RECEIPT_META_KEY]);
const bundle = JSON.parse(readFileSync(join(fx.receiptsDir, `${id}.json`), "utf8")) as ReceiptBundle;

step(1, "verify with public keys only (CLI: node src/cli.ts verify <bundle> --issuer-key gateway.pub --principal-key principal.pub)");
const keys = { issuerKeys: [loadPublicKey(fx.gatewayPub)], principalKeys: [loadPublicKey(fx.principalPub)] };
const v1 = verifyBundle(bundle, keys);
console.log("   ok:", v1.ok, `(${v1.checks.length} checks)`);

step(2, "add a copy of the log; one more check recomputes the root from the file");
const v2 = verifyBundle(bundle, { ...keys, logFile: fx.logFile });
console.log("   ok:", v2.ok, `(${v2.checks.length} checks)`);
console.log(formatReport(v2).split("\n").map((l) => "   " + l).join("\n"));

step(3, "someone edits the amount inside the receipt");
const st = JSON.parse(Buffer.from(bundle.envelope.payload, "base64").toString()) as ReceiptStatement;
st.predicate.request.args.amount = 1;
const edited = { ...bundle, envelope: { ...bundle.envelope, payload: Buffer.from(JSON.stringify(st)).toString("base64") } };
const v3 = verifyBundle(edited, keys);
console.log("   ok:", v3.ok, "first failing check:", v3.checks.find((c) => !c.ok)?.name);

step(4, "a receipt from a key the verifier does not trust");
const v4 = verifyBundle(bundle, { issuerKeys: [loadPublicKey(fx.principalPub)], principalKeys: [] });
console.log("   ok:", v4.ok, "detail:", v4.checks[0]?.detail);

step(5, "the checks are data, so a CI job can gate on any subset");
console.log("   " + v2.checks.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.name}`).join("\n   "));

console.log("\nOK");

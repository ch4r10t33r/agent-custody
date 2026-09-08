// Aspect: consequential tools, committed before they run. Source: src/gateway.ts, src/issue.ts, src/verify.ts
// Run:    node examples/16-precommit.ts
//
// For most calls the gateway forwards, then records. For a refund that is the wrong order: if the log refuses the
// leaf after Stripe has paid out, the side effect exists and the evidence does not. Naming a tool in `precommit`
// makes the gateway commit a signed authorization to the log first and forward only if the log took it.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { loadPrivateKey, loadPublicKey } from "../src/crypto.ts";
import { createGateway, RECEIPT_META_KEY } from "../src/gateway.ts";
import { fileLog, type LogSink } from "../src/log-sink.ts";
import type { ReceiptBundle, ReceiptStatement } from "../src/receipt.ts";
import { formatReport, verifyBundle } from "../src/verify.ts";
import { buildFixture } from "../scripts/fixture.ts";
import { out, step } from "./_out.ts";

const fx = buildFixture(out("16-precommit"));
const cfg = JSON.parse(readFileSync(fx.configFile, "utf8"));
cfg.precommit = ["stripe.refund"];
writeFileSync(fx.configFile, JSON.stringify(cfg));
const decode = (b: ReceiptBundle) => JSON.parse(Buffer.from(b.envelope.payload, "base64").toString()) as ReceiptStatement;
const keys = { issuerKeys: [loadPublicKey(fx.gatewayPub)], principalKeys: [loadPublicKey(fx.principalPub)], logFile: fx.logFile };

step(1, 'gateway.json names stripe.refund in "precommit"; customer.lookup is not consequential');
const gw = await createGateway(loadConfig(fx.configFile));
const ok = await gw.handleCall({ name: "stripe.refund", arguments: { customer_id: "cust_123", amount: 2500 } });
await gw.close();
const id = String(ok._meta?.[RECEIPT_META_KEY]);
const bundle = JSON.parse(readFileSync(join(fx.receiptsDir, `${id}.json`), "utf8")) as ReceiptBundle;
const p = decode(bundle).predicate;
console.log("   executed:", p.execution.status, "| authorization committed as leaf", p.authorization!.inclusion.leafIndex, "| receipt is leaf", bundle.inclusion.leafIndex);
console.log("   the authorization is also its own file:", `${id}.authorization.json`);

step(2, "the verifier proves the order: five authorization checks, then the usual ones");
const v = verifyBundle(bundle, keys);
console.log("   ok:", v.ok);
console.log(formatReport(v).split("\n").filter((l) => l.includes("authorization")).map((l) => "   " + l).join("\n"));

step(3, "the same call when the log will not take the authorization: nothing is forwarded");
const fx2 = buildFixture(out("16-precommit-withheld"));
writeFileSync(fx2.configFile, JSON.stringify({ ...JSON.parse(readFileSync(fx2.configFile, "utf8")), precommit: ["stripe.refund"] }));
const real = fileLog(fx2.logFile, loadPrivateKey(join(fx2.dir, "keys", "gateway.key")));
const refusing: LogSink = {
  kind: real.kind,
  where: real.where,
  async append(leaf) {
    const st = JSON.parse(Buffer.from((JSON.parse(leaf) as { payload: string }).payload, "base64").toString()) as { predicateType: string };
    if (st.predicateType.includes("/authorization/")) throw new Error("log unreachable");
    return real.append(leaf);
  },
};
const gw2 = await createGateway(loadConfig(fx2.configFile), { log: refusing });
const withheld = await gw2.handleCall({ name: "stripe.refund", arguments: { customer_id: "cust_123", amount: 2500 } });
await gw2.close();
console.log("   the agent sees:", (withheld.content[0] as { text: string }).text);
const wb = JSON.parse(readFileSync(join(fx2.receiptsDir, `${String(withheld._meta?.[RECEIPT_META_KEY])}.json`), "utf8")) as ReceiptBundle;
const wp = decode(wb).predicate;
console.log("   the receipt says: policy", wp.policy?.decision, "-> execution", wp.execution.status);

if (!v.ok || p.execution.status !== "executed" || wp.execution.status !== "withheld" || p.authorization!.inclusion.leafIndex >= bundle.inclusion.leafIndex) throw new Error("unexpected state");
console.log("\nOK");

// Aspect: Splunk export. Source: src/splunk.ts, src/otel.ts
// Run:    node examples/19-splunk.ts
//
// The security team already has an index and the searches they watch. With `splunk` in the config, every receipt is
// also one event at their HTTP Event Collector, with the receipt id and log position on it, so an alert leads to the
// receipt that proves the action. The event is a copy; the receipt is the evidence. A collector outage never costs a
// receipt, and the token comes from the environment, never the config file.
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { loadSdkConfig } from "../src/config.ts";
import { createSdkIssuer } from "../src/sdk/index.ts";
import { buildSdkFixture } from "../scripts/fixture.ts";
import { out, step } from "./_out.ts";

step(1, "a stand-in HTTP Event Collector on a free port that prints what it receives");
const received: any[] = [];
const collector = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"text":"Success","code":0}');
  });
});
await new Promise<void>((r) => collector.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(collector.address() as { port: number }).port}`;
console.log("   collector:", url);

step(2, 'sdk.json gains "splunk": { "url", "tokenEnv", "index" }; the token is read from the environment at startup');
process.env.EXAMPLE_HEC_TOKEN = "example-token";
const fx = buildSdkFixture(out("19-splunk"), undefined, "example");
const cfg = JSON.parse(readFileSync(fx.configFile, "utf8"));
cfg.splunk = { url, tokenEnv: "EXAMPLE_HEC_TOKEN", index: "agents" };
writeFileSync(fx.configFile, JSON.stringify(cfg, null, 2));
const issuer = createSdkIssuer(loadSdkConfig(fx.configFile));

step(3, "two receipts: an executed lookup and a denied refund");
const a = await issuer.record({ tool: "crm.lookup", args: { id: "acct:42" } }, { status: "executed", result: { plan: "pro" } });
const b = await issuer.record({ tool: "stripe.refund", args: { amount: 500000 } }, { status: "denied", reason: "over limit" }, issuer.decide({ tool: "stripe.refund", args: { amount: 500000 } }));

step(4, "what the collector got: one event per receipt, the token as the Splunk authorization, receipt id and log position on the event");
for (const r of received) {
  const e = r.body.event;
  console.log(`   ${r.path}  ${r.auth}  index ${r.body.index}  sourcetype ${r.body.sourcetype}  tool ${e.tool}  status ${e.status}  decision ${e.policy_decision ?? "-"}  leaf ${e.log_leaf_index}  receipt ${e.receipt_id}`);
}

step(5, "the collector goes away; the next receipt is still issued, with a warning on stderr");
collector.close();
await new Promise((r) => setTimeout(r, 50));
const c = await issuer.record({ tool: "crm.lookup", args: { id: "acct:43" } }, { status: "executed", result: { plan: "free" } });
console.log("   receipt issued at leaf", c.inclusion.leafIndex);

const ids = [a, b].map((x) => JSON.parse(Buffer.from(x.envelope.payload, "base64").toString()).predicate.receiptId);
if (received.length !== 2 || received.map((r) => r.body.event.receipt_id).join() !== ids.join() || received[0].auth !== "Splunk example-token" || c.inclusion.leafIndex !== 2) throw new Error("unexpected state");
console.log("\nOK");

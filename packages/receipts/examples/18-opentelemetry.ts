// Aspect: OpenTelemetry export. Source: src/otel.ts, src/issue.ts
// Run:    node examples/18-opentelemetry.ts
//
// Nobody wants a new dashboard. With `otel` in the config, every receipt is also one span at the collector the team
// already runs, and the span's trace id is the receipt id, so a trace in Grafana or Datadog leads to the receipt that
// proves it. The span is a pointer; the receipt is the evidence. A collector outage never costs a receipt.
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { loadSdkConfig } from "../src/config.ts";
import { createSdkIssuer } from "../src/sdk/index.ts";
import { buildSdkFixture } from "../scripts/fixture.ts";
import { out, step } from "./_out.ts";

step(1, "a stand-in OTLP/HTTP collector on a free port that prints what it receives");
const received: any[] = [];
const collector = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ path: req.url, body: JSON.parse(body) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});
await new Promise<void>((r) => collector.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(collector.address() as { port: number }).port}`;
console.log("   collector:", url);

step(2, 'sdk.json gains "otel": { "url": ... }; the same block works in gateway.json');
const fx = buildSdkFixture(out("18-otel"), undefined, "example");
const cfg = JSON.parse(readFileSync(fx.configFile, "utf8"));
cfg.otel = { url, serviceName: "support-agents" };
writeFileSync(fx.configFile, JSON.stringify(cfg, null, 2));
const issuer = createSdkIssuer(loadSdkConfig(fx.configFile));

step(3, "two receipts: an executed lookup and a denied refund");
const a = await issuer.record({ tool: "crm.lookup", args: { id: "acct:42" } }, { status: "executed", result: { plan: "pro" } });
const b = await issuer.record({ tool: "stripe.refund", args: { amount: 500000 } }, { status: "denied", reason: "over limit" }, issuer.decide({ tool: "stripe.refund", args: { amount: 500000 } }));

step(4, "what the collector got: one span per receipt, trace id = receipt id, attributes with tool, status, decision, log position");
for (const r of received) {
  const span = r.body.resourceSpans[0].scopeSpans[0].spans[0];
  const attrs = Object.fromEntries(span.attributes.map((x: any) => [x.key, Object.values(x.value)[0]]));
  console.log(`   ${r.path}  span ${span.name}  trace ${span.traceId}  status ${attrs["agent_custody.execution.status"]}  decision ${attrs["agent_custody.policy.decision"] ?? "-"}  leaf ${attrs["agent_custody.log.leaf_index"]}`);
}

step(5, "the collector goes away; the next receipt is still issued, with a warning on stderr");
collector.close();
await new Promise((r) => setTimeout(r, 50));
const c = await issuer.record({ tool: "crm.lookup", args: { id: "acct:43" } }, { status: "executed", result: { plan: "free" } });
console.log("   receipt issued at leaf", c.inclusion.leafIndex);

const ids = [a, b].map((x) => JSON.parse(Buffer.from(x.envelope.payload, "base64").toString()).predicate.receiptId.replace(/-/g, ""));
if (received.length !== 2 || received.map((r) => r.body.resourceSpans[0].scopeSpans[0].spans[0].traceId).join() !== ids.join() || c.inclusion.leafIndex !== 2) throw new Error("unexpected state");
console.log("\nOK");

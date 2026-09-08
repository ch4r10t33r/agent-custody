// Aspect: a REST API as an upstream. Source: src/rest.ts, src/gateway.ts
// Run:    node examples/17-rest-upstream.ts
//
// Most of what an agent touches is not an MCP server but an HTTP API. Describe the API's endpoints as tools in the
// gateway config and the agent calls them through the gateway: the API key stays in the gateway's environment,
// policy decides on a lookup the gateway made itself, and every call has a receipt, exactly as with an MCP upstream.
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { loadPublicKey } from "../src/crypto.ts";
import { createGateway, RECEIPT_META_KEY } from "../src/gateway.ts";
import type { ReceiptBundle, ReceiptStatement } from "../src/receipt.ts";
import { formatReport, verifyBundle } from "../src/verify.ts";
import { buildFixture } from "../scripts/fixture.ts";
import { out, step } from "./_out.ts";

step(1, "a stand-in payments API on a free port: GET /v1/customers/{id} and POST /v1/refunds, which needs a bearer token");
const api = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    const m = /^\/v1\/customers\/([^/?]+)/.exec(req.url ?? "");
    if (req.method === "GET" && m) return json(200, { id: m[1], verified: true, plan: "pro" });
    if (req.method === "POST" && req.url === "/v1/refunds") {
      if (req.headers.authorization !== "Bearer sk_example") return json(401, { error: "no key" });
      return json(200, { refund_id: "re_42", ...JSON.parse(body), status: "succeeded" });
    }
    json(404, { error: "no such route" });
  });
});
await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
console.log("   api:", baseUrl);

step(2, "gateway.json describes the API as two tools; the token comes from the environment through headerEnv, never from the file");
process.env.EXAMPLE_PAYMENTS_BEARER = "Bearer sk_example";
const fx = buildFixture(out("17-rest"));
const cfg = JSON.parse(readFileSync(fx.configFile, "utf8"));
cfg.upstream = {
  rest: {
    baseUrl,
    headerEnv: { authorization: "EXAMPLE_PAYMENTS_BEARER" },
    tools: [
      { name: "customer.lookup", method: "GET", path: "/v1/customers/{customer_id}", inputSchema: { type: "object", properties: { customer_id: { type: "string" } }, required: ["customer_id"] } },
      { name: "stripe.refund", method: "POST", path: "/v1/refunds", description: "Refund a customer, amount in minor units", inputSchema: { type: "object", properties: { customer_id: { type: "string" }, amount: { type: "integer" } }, required: ["customer_id", "amount"] } },
    ],
  },
};
cfg.precommit = ["stripe.refund"];
writeFileSync(fx.configFile, JSON.stringify(cfg, null, 2));
console.log(JSON.stringify(cfg.upstream, null, 2).split("\n").map((l) => "   " + l).join("\n"));

step(3, "the agent calls stripe.refund through the gateway: the gateway looks the customer up itself, policy allows, the authorization is logged, the refund goes out");
const gw = await createGateway(loadConfig(fx.configFile));
const res = await gw.handleCall({ name: "stripe.refund", arguments: { customer_id: "cust_123", amount: 2500 } });
console.log("   result:", (res.content[0] as { text: string }).text);
const id = String(res._meta?.[RECEIPT_META_KEY]);
const bundle = JSON.parse(readFileSync(join(fx.receiptsDir, `${id}.json`), "utf8")) as ReceiptBundle;
const p = (JSON.parse(Buffer.from(bundle.envelope.payload, "base64").toString()) as ReceiptStatement).predicate;
console.log("   the receipt's fact, fetched by the gateway over REST:", JSON.stringify(p.facts.customer?.value));

step(4, "an over-limit refund is denied by policy and never reaches the API");
const denied = await gw.handleCall({ name: "stripe.refund", arguments: { customer_id: "cust_123", amount: 5_000_000 } });
console.log("   agent sees:", (denied.content[0] as { text: string }).text);
await gw.close();
api.close();

step(5, "the receipt verifies like any gateway receipt");
const v = verifyBundle(bundle, { issuerKeys: [loadPublicKey(fx.gatewayPub)], principalKeys: [loadPublicKey(fx.principalPub)], logFile: fx.logFile });
console.log(formatReport(v).split("\n").filter((l) => /RESULT|^tool|^execution|^authorization/.test(l)).map((l) => "   " + l).join("\n"));

if (!v.ok || p.execution.status !== "executed" || !denied.isError) throw new Error("unexpected state");
console.log("\nOK");

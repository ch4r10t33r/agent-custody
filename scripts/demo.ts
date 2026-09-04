// End-to-end demo: an agent talks to fake Stripe through the gateway over MCP, then an auditor verifies the receipts.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadPublicKey } from "../src/crypto.ts";
import { MODEL_META_KEY, RECEIPT_META_KEY } from "../src/gateway.ts";
import type { ReceiptBundle, ReceiptStatement } from "../src/receipt.ts";
import { loadSdkConfig } from "../src/config.ts";
import { generateKeyPair, writeKeyPair } from "../src/crypto.ts";
import { createSdkIssuer, PolicyDeniedError } from "../src/sdk/index.ts";
import { formatReport, verifyBundle } from "../src/verify.ts";
import { buildFixture } from "./fixture.ts";

const fx = buildFixture(resolve("demo-out"));
const hr = (t: string) => console.log(`\n${"=".repeat(8)} ${t} ${"=".repeat(Math.max(0, 60 - t.length))}`);

hr("1. agent connects to fake Stripe through the gateway");
const agent = new Client({ name: "demo-agent", version: "0.0.0" });
await agent.connect(
  new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", resolve("src/cli.ts"), "gateway", "--config", fx.configFile], stderr: "inherit" }),
);
console.log("tools visible to the agent:", (await agent.listTools()).tools.map((t) => t.name).join(", "));

const calls: [string, string, Record<string, unknown>][] = [
  ["refund £500 to a verified customer", "stripe.refund", { customer_id: "cust_123", amount: 50000 }],
  ["refund £5,000, over the policy limit", "stripe.refund", { customer_id: "cust_123", amount: 500000 }],
  ["refund £500 to an unverified customer", "stripe.refund", { customer_id: "cust_999", amount: 50000 }],
  ["payout, a tool outside the delegated scope", "stripe.payout", { amount: 100 }],
];
const receiptIds: string[] = [];
for (const [label, name, args] of calls) {
  const r = (await agent.callTool({ name, arguments: args, _meta: { [MODEL_META_KEY]: "claude-fable-5-1" } })) as CallToolResult;
  const id = String(r._meta?.[RECEIPT_META_KEY]);
  receiptIds.push(id);
  const text = r.content.find((c) => c.type === "text");
  console.log(`\n> ${label}\n  ${r.isError ? "DENIED  " : "EXECUTED"} ${text?.type === "text" ? text.text : ""}\n  receipt ${id}`);
}
await agent.close();

hr("2. auditor verifies every receipt with public keys and a copy of the log");
const opts = { issuerKeys: [loadPublicKey(fx.gatewayPub)], principalKeys: [loadPublicKey(fx.principalPub)], logFile: fx.logFile };
for (const id of receiptIds) {
  const bundle = JSON.parse(readFileSync(join(fx.receiptsDir, `${id}.json`), "utf8")) as ReceiptBundle;
  console.log(`\n--- ${id}`);
  console.log(formatReport(verifyBundle(bundle, opts)));
}

hr("3. someone edits the first receipt to make the refund look smaller");
const original = JSON.parse(readFileSync(join(fx.receiptsDir, `${receiptIds[0]}.json`), "utf8")) as ReceiptBundle;
const statement = JSON.parse(Buffer.from(original.envelope.payload, "base64").toString()) as ReceiptStatement;
statement.predicate.request.args.amount = 1;
const tampered: ReceiptBundle = { ...original, envelope: { ...original.envelope, payload: Buffer.from(JSON.stringify(statement)).toString("base64") } };
writeFileSync(join(fx.dir, "tampered.json"), JSON.stringify(tampered, null, 2));
console.log(formatReport(verifyBundle(tampered, opts)));

hr("4. the same tool wrapped by the in-process SDK, no gateway involved");
const app = writeKeyPair(generateKeyPair(), join(fx.dir, "keys"), "app");
writeFileSync(join(fx.dir, "sdk-policy.cedar"), `permit(principal, action == Action::"stripe.refund", resource) when { context.args.amount <= 100000 };\n`);
writeFileSync(
  join(fx.dir, "sdk.json"),
  JSON.stringify({ agentId: "billing-bot", principalId: "user_456", identity: { keyFile: "keys/app.key" }, policyFile: "sdk-policy.cedar", receiptsDir: "sdk-receipts", logFile: "sdk-log.jsonl", framework: "demo" }, null, 2),
);
const sdk = createSdkIssuer(loadSdkConfig(join(fx.dir, "sdk.json")));
const refund = sdk.wrap("stripe.refund", async (a: { customer_id: string; amount: number }) => ({ refund_id: "re_sdk", ...a, status: "succeeded" }), { model: "claude-fable-5-1" });
const sdkIds: string[] = [];
for (const amount of [50000, 500000]) {
  try {
    const r = await refund({ customer_id: "cust_123", amount });
    console.log(`\n> sdk refund ${amount}\n  EXECUTED ${JSON.stringify(r)}`);
  } catch (e) {
    if (!(e instanceof PolicyDeniedError)) throw e;
    console.log(`\n> sdk refund ${amount}\n  DENIED   ${e.message}`);
  }
}
const sdkOpts = { issuerKeys: [loadPublicKey(app.pubFile)], principalKeys: [], logFile: join(fx.dir, "sdk-log.jsonl") };
for (const line of readFileSync(join(fx.dir, "sdk-log.jsonl"), "utf8").trim().split("\n")) {
  const env = JSON.parse(JSON.parse(line)) as ReceiptBundle["envelope"];
  const id = (JSON.parse(Buffer.from(env.payload, "base64").toString()) as ReceiptStatement).predicate.receiptId;
  sdkIds.push(id);
  console.log(`\n--- ${id}`);
  console.log(formatReport(verifyBundle(JSON.parse(readFileSync(join(fx.dir, "sdk-receipts", `${id}.json`), "utf8")) as ReceiptBundle, sdkOpts)));
}

console.log(`\nArtifacts in ${fx.dir}: keys/, grant.json, policy.cedar, gateway.json, receipts/, log.jsonl, tampered.json, sdk.json, sdk-receipts/, sdk-log.jsonl`);
console.log(`Try the CLI:\n  node src/cli.ts verify demo-out/receipts/${receiptIds[0]}.json --issuer-key demo-out/keys/gateway.pub --principal-key demo-out/keys/principal.pub --log demo-out/log.jsonl`);
console.log(`  node src/cli.ts verify demo-out/sdk-receipts/${sdkIds[0]}.json --issuer-key demo-out/keys/app.pub`);

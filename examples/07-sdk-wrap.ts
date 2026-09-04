// Aspect: the in-process SDK. Source: src/sdk/index.ts
// Run:    npx tsx examples/07-sdk-wrap.ts
//
// No gateway, no MCP. Wrap a function; every call gets a receipt. Everything the SDK records is labelled
// "claimed" because it shares a process with the agent, and the receipt says so.
import { loadSdkConfig } from "../src/config.ts";
import { loadPublicKey } from "../src/crypto.ts";
import { createSdkIssuer, PolicyDeniedError, receiptIdOf } from "../src/sdk/index.ts";
import { formatReport, verifyBundle } from "../src/verify.ts";
import { buildSdkFixture } from "../scripts/fixture.ts";
import { out, step } from "./_out.ts";

const fx = buildSdkFixture(out("07-sdk"), undefined, "example");

step(1, "sdk.json names the agent, an application key, an optional policy, and where receipts go");
const issuer = createSdkIssuer(loadSdkConfig(fx.configFile));
console.log("   agent:", issuer.agentId, "keyid:", issuer.keyid.slice(0, 16) + "…");

step(2, "wrap the function that does the work; the wrapper decides, runs, and records");
const refund = issuer.wrap("stripe.refund", async (a: { customer_id: string; amount: number }) => ({ refund_id: "re_1", amount: a.amount }), { model: "claude-fable-5-1" });

step(3, "an allowed call returns the function's result");
console.log("   result:", JSON.stringify(await refund({ customer_id: "cust_123", amount: 50000 })));

step(4, "a denied call throws before the function runs; the error carries the receipt id");
try {
  await refund({ customer_id: "cust_123", amount: 500000 });
} catch (e) {
  if (!(e instanceof PolicyDeniedError)) throw e;
  console.log("   denied:", e.message);
}

step(5, "an error inside the function is recorded and rethrown");
const flaky = issuer.wrap("customer.lookup", async (_a: { id: string }) => {
  throw new Error("upstream down");
});
await flaky({ id: "c1" }).catch((e: Error) => console.log("   rethrown:", e.message));

step(6, "the primitives underneath wrap(), for frameworks where you cannot wrap");
const ev = { tool: "stripe.refund", args: { customer_id: "cust_123", amount: 1 } };
const decision = issuer.decide(ev);
const bundle = issuer.record(ev, { status: "executed", result: { ok: true } }, decision);
console.log("   decision:", decision?.decision, "receipt:", receiptIdOf(bundle));

step(7, "an SDK receipt verifies like any other, and the report says what it is worth");
console.log(formatReport(verifyBundle(bundle, { issuerKeys: [loadPublicKey(fx.appPub)], principalKeys: [] })).split("\n").slice(-12).map((l) => "   " + l).join("\n"));

console.log("\nOK");

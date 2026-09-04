// Aspect: the LangChain adapter. Source: src/sdk/langchain.ts
// Run:    npx tsx examples/11-langchain.ts
//
// LangChain callbacks observe but cannot block. Record with the handler; enforce by wrapping the function.
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { loadSdkConfig } from "../src/config.ts";
import { createSdkIssuer, PolicyDeniedError } from "../src/sdk/index.ts";
import { receiptCallbacks } from "../src/sdk/langchain.ts";
import { buildSdkFixture } from "../scripts/fixture.ts";
import { out, step } from "./_out.ts";

const fx = buildSdkFixture(out("11-langchain"), undefined, "langchain");
const issuer = createSdkIssuer(loadSdkConfig(fx.configFile));
const schema = z.object({ customer_id: z.string(), amount: z.number() });

step(1, "record only: attach the callback handler to an invoke (or to a compiled graph's config)");
const refund = tool(async (a) => ({ refund_id: "re_1", amount: a.amount }), { name: "stripe.refund", description: "refund", schema });
console.log("   result:", JSON.stringify(await refund.invoke({ customer_id: "cust_123", amount: 500000 }, receiptCallbacks(issuer))), "(recorded; no policy, so not denied)");

step(2, "with a ToolCall input the receipt keeps the tool_call id");
await refund.invoke({ id: "call_7", name: "stripe.refund", args: { customer_id: "cust_123", amount: 1 }, type: "tool_call" }, receiptCallbacks(issuer));
console.log("   recorded call_7");

step(3, "enforcement: build the tool from issuer.wrap(); do not also attach the handler to it");
const enforced = tool(issuer.wrap("stripe.refund", async (a: z.infer<typeof schema>) => ({ amount: a.amount })), { name: "stripe.refund", description: "refund", schema });
try {
  await enforced.invoke({ customer_id: "cust_123", amount: 500000 });
} catch (e) {
  if (!(e instanceof PolicyDeniedError)) throw e;
  console.log("   denied:", e.message);
}
console.log("   receipts in", fx.receiptsDir);

console.log("\nOK");

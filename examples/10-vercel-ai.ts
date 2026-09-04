// Aspect: the Vercel AI SDK adapter. Source: src/sdk/vercel-ai.ts
// Run:    npx tsx examples/10-vercel-ai.ts
//
// The SDK's own MockLanguageModelV4 stands in for the LLM; generateText, tools, and the tool loop are real.
import { generateText, stepCountIs, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { loadSdkConfig } from "../src/config.ts";
import { createSdkIssuer } from "../src/sdk/index.ts";
import { wrapTools } from "../src/sdk/vercel-ai.ts";
import { buildSdkFixture } from "../scripts/fixture.ts";
import { out, step } from "./_out.ts";

const fx = buildSdkFixture(out("10-vercel"), `permit(principal, action == Action::"stripe_refund", resource) when { context.args.amount <= 100000 };`, "vercel-ai");
const issuer = createSdkIssuer(loadSdkConfig(fx.configFile));

type DoGenerate = NonNullable<NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>["doGenerate"]>;
function scriptedModel(amount: number) {
  let step = 0;
  const usage = { inputTokens: { total: 0 }, outputTokens: { total: 0 } };
  const doGenerate = (async () =>
    ++step === 1
      ? { content: [{ type: "tool-call", toolCallId: "call_1", toolName: "stripe_refund", input: JSON.stringify({ customer_id: "cust_123", amount }) }], finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage, warnings: [] }
      : { content: [{ type: "text", text: "done" }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }) as unknown as DoGenerate;
  return new MockLanguageModelV4({ doGenerate });
}
const tools = {
  stripe_refund: tool({ description: "refund", inputSchema: z.object({ customer_id: z.string(), amount: z.number() }), execute: async (a) => ({ refund_id: "re_1", amount: a.amount }) }),
};

step(1, "wrap the tool set once; pass it to generateText as usual");
const ok = await generateText({ model: scriptedModel(50000), tools: wrapTools(issuer, tools), prompt: "refund", stopWhen: stepCountIs(3) });
console.log("   text:", ok.text, "| tool result:", JSON.stringify(ok.steps[0]!.toolResults[0]?.output));

step(2, "a denied call surfaces to the model as a tool-error part, and the loop continues");
const denied = await generateText({ model: scriptedModel(500000), tools: wrapTools(issuer, tools), prompt: "refund", stopWhen: stepCountIs(3) });
console.log("   text:", denied.text, "| error part:", JSON.stringify(denied.steps[0]!.content.find((c) => c.type === "tool-error")).slice(0, 200) + "…");
console.log("   receipts in", fx.receiptsDir);

console.log("\nOK");

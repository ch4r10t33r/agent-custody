// Aspect: the OpenAI Agents SDK adapter. Source: src/sdk/openai-agents.ts
// Run:    npx tsx examples/09-openai-agents.ts
//
// A scripted Model stands in for the LLM so this runs offline; everything else is the real SDK.
import { Agent, Runner, setTracingDisabled, tool, Usage, type Model } from "@openai/agents";
import { z } from "zod";
import { loadSdkConfig } from "../src/config.ts";
import { createSdkIssuer } from "../src/sdk/index.ts";
import { observeRunner, wrapTools } from "../src/sdk/openai-agents.ts";
import { buildSdkFixture } from "../scripts/fixture.ts";
import { out, step } from "./_out.ts";

setTracingDisabled(true);
const fx = buildSdkFixture(out("09-openai"), `permit(principal, action == Action::"stripe_refund", resource) when { context.args.amount <= 100000 };`, "openai-agents");
const issuer = createSdkIssuer(loadSdkConfig(fx.configFile));

function scriptedModel(amount: number): Model {
  let turn = 0;
  return {
    async getResponse() {
      turn++;
      const output =
        turn === 1
          ? [{ type: "function_call", callId: "call_1", name: "stripe_refund", arguments: JSON.stringify({ customer_id: "cust_123", amount }), status: "completed" }]
          : [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done" }] }];
      return { usage: new Usage(), output, responseId: `r${turn}` };
    },
    async *getStreamedResponse() {
      throw new Error("not used");
    },
  } as unknown as Model;
}
const refund = tool({ name: "stripe_refund", description: "refund", parameters: z.object({ customer_id: z.string(), amount: z.number() }), execute: async (a) => ({ refund_id: "re_1", amount: a.amount }) });

step(1, "enforcement: hand the agent wrapped tools");
const agent = new Agent({ name: "billing", tools: wrapTools(issuer, [refund]), model: scriptedModel(50000) });
console.log("   final output:", (await new Runner().run(agent, "refund")).finalOutput);

step(2, "a denied call: the tool never runs; the model receives the denial as the tool result and finishes anyway");
const denied = new Agent({ name: "billing", tools: wrapTools(issuer, [refund]), model: scriptedModel(500000) });
const res = await new Runner().run(denied, "refund");
console.log("   final output:", res.finalOutput);
console.log("   tool result seen by the model:", res.newItems.map((i) => JSON.stringify(i.rawItem)).find((s) => s.includes("function_call_result"))?.slice(0, 160) + "…");

step(3, "record only: observeRunner hooks lifecycle events and evaluates no policy");
const runner = new Runner();
observeRunner(issuer, runner);
await runner.run(new Agent({ name: "billing", tools: [refund], model: scriptedModel(500000) }), "refund");
console.log("   receipts in", fx.receiptsDir);

console.log("\nOK");

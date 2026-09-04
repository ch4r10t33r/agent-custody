import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, Runner, RunContext, Usage, setTracingDisabled, tool, type Model } from "@openai/agents";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadSdkConfig } from "../../src/config.ts";
import { loadPublicKey } from "../../src/crypto.ts";
import { createSdkIssuer, type SdkIssuer } from "../../src/sdk/index.ts";
import { observeRunner, wrapTools } from "../../src/sdk/openai-agents.ts";
import { verifyBundle } from "../../src/verify.ts";
import { buildSdkFixture, type SdkFixture } from "../../scripts/fixture.ts";
import { receipts } from "../helpers.ts";

setTracingDisabled(true);

const POLICY = `permit(principal, action == Action::"stripe_refund", resource) when { context.args.amount <= 100000 };`;

/** A model that emits the scripted tool calls one per turn, then says "done". No network. */
function scriptedModel(calls: { name: string; args: Record<string, unknown> }[]): Model {
  let turn = 0;
  return {
    async getResponse() {
      const c = calls[turn++];
      const output = c
        ? [{ type: "function_call", callId: `call_${turn}`, name: c.name, arguments: JSON.stringify(c.args), status: "completed" }]
        : [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done" }] }];
      return { usage: new Usage(), output, responseId: `r${turn}` };
    },
    async *getStreamedResponse() {
      throw new Error("not used");
    },
  } as unknown as Model;
}

let fx: SdkFixture;
let issuer: SdkIssuer;
let executed: number;
const refundTool = () =>
  tool({
    name: "stripe_refund",
    description: "refund",
    parameters: z.object({ customer_id: z.string(), amount: z.number() }),
    execute: async (a) => {
      executed++;
      return { refund_id: "re_1", amount: a.amount };
    },
  });

beforeAll(() => {
  fx = buildSdkFixture(mkdtempSync(join(tmpdir(), "ar-openai-")), POLICY, "openai-agents");
  issuer = createSdkIssuer(loadSdkConfig(fx.configFile));
});

describe("OpenAI Agents SDK adapter", () => {
  it("wrapTools: an allowed call runs through a real Runner and yields a verifiable receipt with the call id", async () => {
    executed = 0;
    const agent = new Agent({ name: "billing", tools: wrapTools(issuer, [refundTool()]), model: scriptedModel([{ name: "stripe_refund", args: { customer_id: "c1", amount: 500 } }]) });
    const res = await new Runner().run(agent, "refund");
    expect(res.finalOutput).toBe("done");
    expect(executed).toBe(1);
    const { bundle, st } = receipts(fx).at(-1)!;
    expect(st.predicate.issuer).toMatchObject({ kind: "sdk", framework: "openai-agents" });
    expect(st.predicate.tool.name).toBe("stripe_refund");
    expect(st.predicate.request.args).toEqual({ customer_id: "c1", amount: 500 });
    expect(st.predicate.session.toolUseId).toBe("call_1");
    expect(st.predicate.execution).toMatchObject({ status: "executed", result: { refund_id: "re_1", amount: 500 } });
    expect(st.predicate.policy?.decision).toBe("allow");
    const v = verifyBundle(bundle, { issuerKeys: [loadPublicKey(fx.appPub)], principalKeys: [], logFile: fx.logFile });
    expect(v.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it("wrapTools: a denied call never executes; the model sees the denial as the tool result and the run continues", async () => {
    executed = 0;
    const agent = new Agent({ name: "billing", tools: wrapTools(issuer, [refundTool()]), model: scriptedModel([{ name: "stripe_refund", args: { customer_id: "c1", amount: 999999 } }]) });
    const res = await new Runner().run(agent, "refund");
    expect(res.finalOutput).toBe("done");
    expect(executed).toBe(0);
    const resultItem = res.newItems.map((i) => JSON.stringify(i.rawItem)).find((s) => s.includes("function_call_result"));
    expect(resultItem).toMatch(/Denied by policy/);
    const { st } = receipts(fx).at(-1)!;
    expect(st.predicate.execution.status).toBe("denied");
    expect(st.predicate.policy?.decision).toBe("deny");
  });

  it("observeRunner: records from lifecycle events without wrapping, and evaluates no policy", async () => {
    executed = 0;
    const before = receipts(fx).length;
    const agent = new Agent({ name: "billing", tools: [refundTool()], model: scriptedModel([{ name: "stripe_refund", args: { customer_id: "c2", amount: 999999 } }]) });
    const runner = new Runner();
    observeRunner(issuer, runner);
    await runner.run(agent, "refund");
    expect(executed).toBe(1);
    const all = receipts(fx);
    expect(all.length).toBe(before + 1);
    const { st } = all.at(-1)!;
    expect(st.predicate.session.toolUseId).toBe("call_1");
    expect(st.predicate.request.args).toEqual({ customer_id: "c2", amount: 999999 });
    expect(st.predicate.execution.status).toBe("executed");
    expect(st.predicate.policy).toBeNull();
  });

  it("wrapped tools still work when invoked directly", async () => {
    const [t] = wrapTools(issuer, [refundTool()]);
    await expect(t!.invoke(new RunContext({}), JSON.stringify({ customer_id: "c1", amount: 1 }))).resolves.toEqual({ refund_id: "re_1", amount: 1 });
  });
});

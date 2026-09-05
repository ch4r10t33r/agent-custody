import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText, stepCountIs, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadSdkConfig } from "../../src/config.ts";
import { loadPublicKey } from "../../src/crypto.ts";
import { createSdkIssuer, type SdkIssuer } from "../../src/sdk/index.ts";
import { wrapTools } from "../../src/sdk/vercel-ai.ts";
import { verifyBundle } from "../../src/verify.ts";
import { buildSdkFixture, type SdkFixture } from "../../scripts/fixture.ts";
import { receipts } from "../helpers.ts";

const POLICY = `permit(principal, action == Action::"stripe_refund", resource) when { context.args.amount <= 100000 };`;

type DoGenerate = NonNullable<NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>["doGenerate"]>;

/** A model that emits the scripted tool calls one per step, then says "done". No network. */
function scriptedModel(calls: { name: string; args: Record<string, unknown> }[]) {
  let step = 0;
  const usage = { inputTokens: { total: 0 }, outputTokens: { total: 0 } };
  const doGenerate = (async () => {
    const c = calls[step++];
    return c
      ? { content: [{ type: "tool-call", toolCallId: `call_${step}`, toolName: c.name, input: JSON.stringify(c.args) }], finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage, warnings: [] }
      : { content: [{ type: "text", text: "done" }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
  }) as unknown as DoGenerate;
  return new MockLanguageModelV4({ doGenerate });
}

let fx: SdkFixture;
let issuer: SdkIssuer;
let executed: number;
const tools = () => ({
  stripe_refund: tool({
    description: "refund",
    inputSchema: z.object({ customer_id: z.string(), amount: z.number() }),
    execute: async (a) => {
      executed++;
      return { refund_id: "re_1", amount: a.amount };
    },
  }),
  client_side: tool({ description: "no execute, runs on the client", inputSchema: z.object({}) }),
});

beforeAll(() => {
  fx = buildSdkFixture(mkdtempSync(join(tmpdir(), "ar-vercel-")), POLICY, "vercel-ai");
  issuer = createSdkIssuer(loadSdkConfig(fx.configFile));
});

describe("Vercel AI SDK adapter", () => {
  it("wrapTools: an allowed call runs through a real generateText loop and yields a verifiable receipt", async () => {
    executed = 0;
    const r = await generateText({ model: scriptedModel([{ name: "stripe_refund", args: { customer_id: "c1", amount: 500 } }]), tools: wrapTools(issuer, tools()), prompt: "refund", stopWhen: stepCountIs(3) });
    expect(r.text).toBe("done");
    expect(executed).toBe(1);
    expect(r.steps[0]!.toolResults[0]).toMatchObject({ toolCallId: "call_1", output: { refund_id: "re_1", amount: 500 } });
    const { bundle, st } = receipts(fx).at(-1)!;
    expect(st.predicate.issuer).toMatchObject({ kind: "sdk", framework: "vercel-ai" });
    expect(st.predicate.tool.name).toBe("stripe_refund");
    expect(st.predicate.session.toolUseId).toBe("call_1");
    expect(st.predicate.execution).toMatchObject({ status: "executed", result: { refund_id: "re_1", amount: 500 } });
    expect(st.predicate.policy?.decision).toBe("allow");
    expect(verifyBundle(bundle, { issuerKeys: [loadPublicKey(fx.appPub)], principalKeys: [], logFile: fx.logFile }).ok).toBe(true);
  });

  it("wrapTools: a denied call never executes; the step carries the denial as a tool error and the loop continues", async () => {
    executed = 0;
    const r = await generateText({ model: scriptedModel([{ name: "stripe_refund", args: { customer_id: "c1", amount: 999999 } }]), tools: wrapTools(issuer, tools()), prompt: "refund", stopWhen: stepCountIs(3) });
    expect(r.text).toBe("done");
    expect(executed).toBe(0);
    const { st } = receipts(fx).at(-1)!;
    const errorPart = r.steps[0]!.content.find((c) => c.type === "tool-error");
    expect(errorPart).toBeDefined();
    expect(JSON.stringify(errorPart)).toContain(st.predicate.receiptId);
    expect(st.predicate.execution.status).toBe("denied");
    expect(st.predicate.policy?.decision).toBe("deny");
  });

  it("tools without execute pass through untouched", () => {
    const original = tools();
    const wrapped = wrapTools(issuer, original);
    expect(wrapped.client_side).toBe(original.client_side);
    expect(wrapped.client_side.execute).toBeUndefined();
    expect(typeof wrapped.stripe_refund.execute).toBe("function");
  });
});

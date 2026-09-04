import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@langchain/core/tools";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadSdkConfig } from "../../src/config.ts";
import { loadPublicKey } from "../../src/crypto.ts";
import { createSdkIssuer, PolicyDeniedError, type SdkIssuer } from "../../src/sdk/index.ts";
import { receiptCallbacks } from "../../src/sdk/langchain.ts";
import { verifyBundle } from "../../src/verify.ts";
import { buildSdkFixture, type SdkFixture } from "../../scripts/fixture.ts";
import { receipts } from "../helpers.ts";

let fx: SdkFixture;
let issuer: SdkIssuer;
const schema = z.object({ customer_id: z.string(), amount: z.number() });

beforeAll(() => {
  fx = buildSdkFixture(mkdtempSync(join(tmpdir(), "ar-langchain-")), undefined, "langchain");
  issuer = createSdkIssuer(loadSdkConfig(fx.configFile));
});

describe("LangChain adapter", () => {
  it("callback handler records a tool run observed through a real StructuredTool invoke", async () => {
    const refund = tool(async (a) => ({ refund_id: "re_1", amount: a.amount }), { name: "stripe.refund", description: "refund", schema });
    const out = await refund.invoke({ customer_id: "c1", amount: 500 }, receiptCallbacks(issuer));
    expect(out).toEqual({ refund_id: "re_1", amount: 500 });
    const { bundle, st } = receipts(fx).at(-1)!;
    expect(st.predicate.issuer).toMatchObject({ kind: "sdk", framework: "langchain" });
    expect(st.predicate.tool.name).toBe("stripe.refund");
    expect(st.predicate.request.args).toEqual({ customer_id: "c1", amount: 500 });
    expect(st.predicate.execution).toMatchObject({ status: "executed", result: { refund_id: "re_1", amount: 500 } });
    expect(st.predicate.policy).toBeNull();
    expect(verifyBundle(bundle, { issuerKeys: [loadPublicKey(fx.appPub)], principalKeys: [], logFile: fx.logFile }).ok).toBe(true);
  });

  it("records the tool_call id and unwraps the ToolMessage when invoked with a ToolCall", async () => {
    const refund = tool(async (a) => ({ refund_id: "re_2", amount: a.amount }), { name: "stripe.refund", description: "refund", schema });
    await refund.invoke({ id: "call_9", name: "stripe.refund", args: { customer_id: "c1", amount: 7 }, type: "tool_call" }, receiptCallbacks(issuer));
    const { st } = receipts(fx).at(-1)!;
    expect(st.predicate.session.toolUseId).toBe("call_9");
    expect(st.predicate.execution).toMatchObject({ status: "executed", result: { refund_id: "re_2", amount: 7 } });
  });

  it("records a thrown error as an error receipt", async () => {
    const broken = tool(
      async () => {
        throw new Error("upstream down");
      },
      { name: "customer.lookup", description: "lookup", schema: z.object({ id: z.string() }) },
    );
    await expect(broken.invoke({ id: "c1" }, receiptCallbacks(issuer))).rejects.toThrow("upstream down");
    expect(receipts(fx).at(-1)!.st.predicate.execution).toMatchObject({ status: "error", error: "upstream down" });
  });

  it("enforcement composes: a tool built from issuer.wrap() denies before running, without the handler", async () => {
    let ran = false;
    const refund = tool(
      issuer.wrap("stripe.refund", async (a: z.infer<typeof schema>) => {
        ran = true;
        return { amount: a.amount };
      }),
      { name: "stripe.refund", description: "refund", schema },
    );
    const err = await refund.invoke({ customer_id: "c1", amount: 999999 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyDeniedError);
    expect(ran).toBe(false);
    expect(receipts(fx).at(-1)!.st.predicate.execution.status).toBe("denied");
  });
});

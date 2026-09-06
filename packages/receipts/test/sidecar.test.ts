// The sidecar exists so an agent in any language gets the same receipts as the TypeScript SDK. These tests speak to it
// the way a foreign client would: plain HTTP and JSON, nothing imported from the SDK on the client side.
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSdkConfig } from "../src/config.ts";
import { loadPublicKey } from "../src/crypto.ts";
import { createSdkIssuer } from "../src/sdk/index.ts";
import { serveSidecar, type RunningSidecar } from "../src/sidecar.ts";
import { verifyBundle } from "../src/verify.ts";
import { buildSdkFixture, type SdkFixture } from "../scripts/fixture.ts";

describe("sidecar", () => {
  let fx: SdkFixture;
  let side: RunningSidecar;
  const post = async (path: string, body: unknown) => {
    const res = await fetch(new URL(path, side.url), { method: "POST", body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };

  beforeAll(async () => {
    fx = buildSdkFixture(mkdtempSync(join(tmpdir(), "sidecar-")));
    side = await serveSidecar(createSdkIssuer(loadSdkConfig(fx.configFile)), { port: 0 });
  });
  afterAll(() => side.close());

  it("health names the agent, the key, and where the log is", async () => {
    const h = (await (await fetch(new URL("health", side.url))).json()) as any;
    expect(h.agentId).toBe("billing-bot");
    expect(h.log.kind).toBe("file");
  });

  it("decide runs the configured policy on the event's args", async () => {
    expect((await post("decide", { tool: "stripe.refund", args: { amount: 500 } })).body.decision).toBe("allow");
    expect((await post("decide", { tool: "stripe.refund", args: { amount: 500000 } })).body.decision).toBe("deny");
  });

  it("record issues a receipt that verifies against the app key and the log, with the policy the client got from decide", async () => {
    const policy = (await post("decide", { tool: "stripe.refund", args: { amount: 500 } })).body;
    const r = await post("record", { event: { tool: "stripe.refund", args: { amount: 500 }, session: { id: "s1", toolUseId: "t1" } }, outcome: { status: "executed", result: { refund_id: "re_1" } }, policy });
    expect(r.status).toBe(200);
    const v = verifyBundle(r.body, { issuerKeys: [loadPublicKey(fx.appPub)], principalKeys: [], logFile: fx.logFile });
    expect(v.ok).toBe(true);
    expect(v.statement?.predicate.issuer.kind).toBe("sdk");
    expect(v.statement?.predicate.session).toEqual({ id: "s1", toolUseId: "t1", provenance: "claimed" });
    expect(v.statement?.predicate.policy?.decision).toBe("allow");
    expect(readdirSync(fx.receiptsDir)).toHaveLength(1);
  });

  it("rejects malformed events, outcomes, and policies with 400 and writes nothing", async () => {
    expect((await post("record", { event: { args: {} }, outcome: { status: "executed" } })).status).toBe(400);
    expect((await post("record", { event: { tool: "t" }, outcome: { status: "maybe" } })).status).toBe(400);
    expect((await post("record", { event: { tool: "t" }, outcome: { status: "executed" }, policy: { decision: "allow" } })).status).toBe(400);
    expect(readdirSync(fx.receiptsDir)).toHaveLength(1);
  });
});

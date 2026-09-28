// Observe mode: the policy decides, nothing is blocked, and the receipt says both. The way a new policy is run against
// real traffic before it is turned on. Pinned at every layer that can deny: the gateway, the SDK's wrap, the hook
// adapters, and the sidecar the Python package talks to; and at the verifier, which must accept a recorded-not-enforced
// deny beside an executed call and refuse the same receipt once the flag is stripped.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, loadSdkConfig } from "../src/config.ts";
import { loadPrivateKey, loadPublicKey } from "../src/crypto.ts";
import { createGateway, RECEIPT_META_KEY } from "../src/gateway.ts";
import { handleHookEvent } from "../src/sdk/claude.ts";
import { createSdkIssuer, denies } from "../src/sdk/index.ts";
import { openclawHooks } from "../src/sdk/openclaw.ts";
import { serveSidecar } from "../src/sidecar.ts";
import { verifyBundle } from "../src/verify.ts";
import { dsseSign } from "../src/crypto.ts";
import { buildFixture, buildSdkFixture } from "../scripts/fixture.ts";

const observe = (configFile: string) => {
  const cfg = JSON.parse(readFileSync(configFile, "utf8"));
  cfg.mode = "observe";
  writeFileSync(configFile, JSON.stringify(cfg));
};
const bundleOf = (dir: string, id: string) => JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"));

describe("observe mode", () => {
  it("gateway: an over-limit refund is forwarded, the receipt records deny with enforced: false and an executed call, the verifier accepts it, and the same receipt with the flag stripped and re-signed fails the consistency check", async () => {
    const fx = buildFixture(mkdtempSync(join(tmpdir(), "observe-gw-")));
    observe(fx.configFile);
    const gw = await createGateway(loadConfig(fx.configFile));
    const res = await gw.handleCall({ name: "stripe.refund", arguments: { customer_id: "cust_123", amount: 5000000 } });
    await gw.close();
    expect(res.isError).toBeFalsy(); // forwarded: the stand-in Stripe answered
    const bundle = bundleOf(fx.receiptsDir, String(res._meta?.[RECEIPT_META_KEY]));
    const opts = { issuerKeys: [loadPublicKey(fx.gatewayPub)], principalKeys: [loadPublicKey(fx.principalPub)], logFile: fx.logFile };
    const r = await verifyBundle(bundle, opts);
    expect(r.ok).toBe(true);
    const p = r.statement!.predicate;
    expect(p.policy).toMatchObject({ decision: "deny", enforced: false });
    expect(p.execution.status).toBe("executed");
    expect(r.checks.find((c) => c.name === "policy decision consistent with execution")?.detail).toBe("deny (observe mode, not enforced) -> executed");
    // strip the flag: a deny beside an executed call now claims enforcement, and the verifier refuses it
    const st = JSON.parse(Buffer.from(bundle.envelope.payload, "base64").toString());
    delete st.predicate.policy.enforced;
    const forged = { ...bundle, envelope: dsseSign(bundle.envelope.payloadType, st, loadPrivateKey(join(fx.dir, "keys", "gateway.key"))) };
    const f = await verifyBundle(forged, opts);
    expect(f.ok).toBe(false);
    expect(f.checks.find((c) => c.name === "policy decision consistent with execution")?.ok).toBe(false);
  });

  it("SDK: wrap runs the function on a deny and records deny with enforced: false; the Claude hook returns no decision at PreToolUse and records at PostToolUse; the OpenClaw hook does not block; enforce mode still denies", async () => {
    const fx = buildSdkFixture(mkdtempSync(join(tmpdir(), "observe-sdk-")), undefined, "test");
    observe(fx.configFile);
    const issuer = createSdkIssuer(loadSdkConfig(fx.configFile));
    const policy = issuer.decide({ tool: "stripe.refund", args: { amount: 999999 } });
    expect(policy).toMatchObject({ decision: "deny", enforced: false });
    expect(denies(policy)).toBe(false);
    let ran = 0;
    const refund = issuer.wrap("stripe.refund", async (a: { amount: number }) => { ran++; return { ok: a.amount }; });
    expect(await refund({ amount: 999999 })).toEqual({ ok: 999999 });
    expect(ran).toBe(1);
    expect(await handleHookEvent(issuer, { hook_event_name: "PreToolUse", tool_name: "stripe.refund", tool_input: { amount: 999999 } })).toEqual({});
    await handleHookEvent(issuer, { hook_event_name: "PostToolUse", tool_name: "stripe.refund", tool_input: { amount: 999999 }, tool_response: { refund_id: "re_x" } });
    expect(await openclawHooks(issuer).before_tool_call({ toolName: "stripe.refund", params: { amount: 999999 } })).toBeUndefined();
    const key = loadPublicKey(fx.appPub);
    const statuses: string[] = [];
    for (const f of readdirSync(fx.receiptsDir).filter((n) => n.endsWith(".json"))) {
      const r = await verifyBundle(bundleOf(fx.receiptsDir, f.replace(/\.json$/, "")), { issuerKeys: [key], principalKeys: [], logFile: fx.logFile });
      expect(r.ok).toBe(true);
      expect(r.statement!.predicate.policy).toMatchObject({ decision: "deny", enforced: false });
      statuses.push(r.statement!.predicate.execution.status);
    }
    expect(statuses.sort()).toEqual(["executed", "executed"]);
    // the same fixture in enforce mode denies, so the mode is the only difference
    const ex = buildSdkFixture(mkdtempSync(join(tmpdir(), "enforce-sdk-")), undefined, "test");
    const enforcing = createSdkIssuer(loadSdkConfig(ex.configFile));
    expect(denies(enforcing.decide({ tool: "stripe.refund", args: { amount: 999999 } }))).toBe(true);
    await expect(enforcing.wrap("stripe.refund", async () => "never")({ amount: 999999 })).rejects.toThrow(/Denied by policy/);
  });

  it("sidecar: /decide carries enforced: false in observe mode, so a client in any language can tell a deny it must act on from one it records", async () => {
    const fx = buildSdkFixture(mkdtempSync(join(tmpdir(), "observe-sidecar-")), undefined, "python");
    observe(fx.configFile);
    const side = await serveSidecar(createSdkIssuer(loadSdkConfig(fx.configFile)), { port: 0 });
    try {
      const d = await (await fetch(new URL("decide", side.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "stripe.refund", args: { amount: 999999 } }) })).json();
      expect(d).toMatchObject({ decision: "deny", enforced: false });
      const rec = await fetch(new URL("record", side.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: { tool: "stripe.refund", args: { amount: 999999 } }, outcome: { status: "executed", result: { ok: true } }, policy: d }) });
      expect(rec.status).toBe(200);
      const b = await rec.json();
      const r = await verifyBundle(b, { issuerKeys: [loadPublicKey(fx.appPub)], principalKeys: [], logFile: fx.logFile });
      expect(r.ok).toBe(true);
      expect(r.statement!.predicate.policy).toMatchObject({ decision: "deny", enforced: false });
    } finally {
      await side.close();
    }
  });
});

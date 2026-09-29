// The DeepSeek Harness tool waterfalls (packages/core/tools/src/index.ts in deepseek-ai/deepseek-harness), driven the
// way the harness drives them: pre-execute (exec, next) awaited and returning a decision, post-execute (exec, result,
// next). And the module as a plugin: name, inject, a Standard Schema Config, apply(ctx, config).
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSdkConfig } from "../src/config.ts";
import { loadPublicKey } from "../src/crypto.ts";
import { apply, Config, deepseekHarnessHooks, inject, name, registerDeepSeekHarness, type DshPostToolDecision, type DshPreToolDecision } from "../src/sdk/deepseek-harness.ts";
import { createSdkIssuer } from "../src/sdk/index.ts";
import { verifyBundle } from "../src/verify.ts";
import { buildSdkFixture } from "../scripts/fixture.ts";

const allow = async (): Promise<DshPreToolDecision> => ({ kind: "allow" });
const accept = async (): Promise<DshPostToolDecision> => ({ kind: "accept" });

describe("DeepSeek Harness plugin", () => {
  it("pre-execute denies a policy-denied call with the receipt id in the reason and delegates otherwise; post-execute records executed and failed calls and delegates; every receipt verifies with the session and call ids", async () => {
    const fx = buildSdkFixture(mkdtempSync(join(tmpdir(), "dsh-")), undefined, "deepseek-harness");
    const hooks = deepseekHarnessHooks(createSdkIssuer(loadSdkConfig(fx.configFile)));
    const agent = { session: { header: { id: "sess-1" } } };
    let delegated = 0;
    const counting = async (): Promise<DshPreToolDecision> => { delegated++; return { kind: "allow" }; };
    expect(await hooks.preExecute({ name: "stripe.refund", arguments: { amount: 100 }, callId: "call-1", agent }, counting)).toEqual({ kind: "allow" });
    expect(delegated).toBe(1); // never decides allow itself
    const denied = await hooks.preExecute({ name: "stripe.refund", arguments: { amount: 999999 }, callId: "call-2", agent }, counting);
    expect(denied.kind).toBe("deny");
    expect((denied as { reason: string }).reason).toMatch(/^agent-custody: .* \(receipt [0-9a-f-]{36}\)$/);
    expect(delegated).toBe(1); // a deny is terminal
    expect(await hooks.postExecute({ name: "stripe.refund", arguments: { amount: 100 }, callId: "call-1", agent }, { isError: false, value: { refund_id: "re_1" }, content: [{ type: "text", text: "ok" }] }, accept)).toEqual({ kind: "accept" });
    expect(await hooks.postExecute({ name: "customer.lookup", arguments: { id: "c9" }, callId: "call-3", agent }, { isError: true, error: { message: "upstream timeout" }, content: [] }, accept)).toEqual({ kind: "accept" });
    // arguments that are not an object are recorded as { input }
    await hooks.postExecute({ name: "customer.lookup", arguments: "c9", callId: "call-4" }, { isError: false, value: "", content: [] }, accept);
    const key = loadPublicKey(fx.appPub);
    const seen: string[] = [];
    for (const f of readdirSync(fx.receiptsDir).filter((n) => n.endsWith(".json"))) {
      const r = await verifyBundle(JSON.parse(readFileSync(join(fx.receiptsDir, f), "utf8")), { issuerKeys: [key], principalKeys: [], logFile: fx.logFile });
      expect(r.ok).toBe(true);
      const p = r.statement!.predicate;
      seen.push(`${p.tool.name}:${p.execution.status}:${p.session.id}:${p.session.toolUseId}`);
    }
    expect(seen.sort()).toEqual(["customer.lookup:executed:null:call-4", "customer.lookup:failed:sess-1:call-3", "stripe.refund:denied:sess-1:call-2", "stripe.refund:executed:sess-1:call-1"]);
  });

  it("the module is a plugin: name, inject, a Standard Schema Config, and apply registers both events from the config file or the environment, and refuses to start without either", async () => {
    expect(name).toBe("agent-custody");
    expect(inject).toEqual(["tools"]);
    expect(typeof (Config as unknown as { "~standard": unknown })["~standard"]).toBe("object"); // what Cordis requires of an exported Config
    const fx = buildSdkFixture(mkdtempSync(join(tmpdir(), "dsh-plugin-")), undefined, "deepseek-harness");
    const events: string[] = [];
    apply({ on: (event) => events.push(event) }, { config: fx.configFile });
    expect(events).toEqual(["tools/pre-execute", "tools/post-execute"]);
    const prev = process.env.AGENT_CUSTODY_CONFIG;
    delete process.env.AGENT_CUSTODY_CONFIG;
    expect(() => apply({ on: () => {} }, {})).toThrow(/AGENT_CUSTODY_CONFIG/);
    process.env.AGENT_CUSTODY_CONFIG = fx.configFile;
    const viaEnv: string[] = [];
    apply({ on: (event) => viaEnv.push(event) });
    expect(viaEnv).toHaveLength(2);
    if (prev === undefined) delete process.env.AGENT_CUSTODY_CONFIG; else process.env.AGENT_CUSTODY_CONFIG = prev;
    const names: string[] = [];
    registerDeepSeekHarness({ on: (event) => names.push(event) }, createSdkIssuer(loadSdkConfig(fx.configFile)));
    expect(names).toEqual(["tools/pre-execute", "tools/post-execute"]);
  });
});

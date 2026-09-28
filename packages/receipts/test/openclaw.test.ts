// The OpenClaw hook contract (src/plugins/hook-types.ts in openclaw/openclaw), driven the way the host drives it:
// before_tool_call(event, ctx) awaited, returning a block or nothing; after_tool_call(event, ctx) with result or error.
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSdkConfig } from "../src/config.ts";
import { loadPublicKey } from "../src/crypto.ts";
import { createSdkIssuer } from "../src/sdk/index.ts";
import { openclawHooks, registerOpenClaw } from "../src/sdk/openclaw.ts";
import { verifyBundle } from "../src/verify.ts";
import { buildSdkFixture } from "../scripts/fixture.ts";

describe("OpenClaw plugin hooks", () => {
  it("before_tool_call blocks a denied call with the receipt id in the reason and returns nothing on allow; after_tool_call records executed and failed calls; every receipt verifies and carries the session and call ids; registerOpenClaw wires both", async () => {
    const fx = buildSdkFixture(mkdtempSync(join(tmpdir(), "openclaw-")), undefined, "openclaw");
    const issuer = createSdkIssuer(loadSdkConfig(fx.configFile));
    const hooks = openclawHooks(issuer);
    const ctx = { agentId: "main", sessionKey: "agent:main:main", sessionId: "sess-1", runId: "run-1" };
    expect(await hooks.before_tool_call({ toolName: "stripe.refund", params: { amount: 100 }, toolCallId: "call-1" }, ctx)).toBeUndefined();
    const blocked = await hooks.before_tool_call({ toolName: "stripe.refund", params: { amount: 999999 }, toolCallId: "call-2" }, ctx);
    expect(blocked).toMatchObject({ block: true });
    expect(blocked!.blockReason).toMatch(/^agent-custody: .* \(receipt [0-9a-f-]{36}\)$/);
    await hooks.after_tool_call({ toolName: "stripe.refund", params: { amount: 100 }, toolCallId: "call-1", result: { refund_id: "re_1" }, durationMs: 5 }, ctx);
    await hooks.after_tool_call({ toolName: "customer.lookup", params: { id: "c9" }, toolCallId: "call-3", error: "upstream timeout" }, ctx);
    const key = loadPublicKey(join(fx.dir, "keys", "app.pub"));
    const seen: string[] = [];
    for (const f of readdirSync(fx.receiptsDir).filter((n) => n.endsWith(".json"))) {
      const r = await verifyBundle(JSON.parse(readFileSync(join(fx.receiptsDir, f), "utf8")), { issuerKeys: [key], principalKeys: [], logFile: fx.logFile });
      expect(r.ok).toBe(true);
      const p = r.statement!.predicate;
      expect(p.session.id).toBe("sess-1");
      seen.push(`${p.tool.name}:${p.execution.status}:${p.session.toolUseId}`);
    }
    expect(seen.sort()).toEqual(["customer.lookup:failed:call-3", "stripe.refund:denied:call-2", "stripe.refund:executed:call-1"]);
    // a params value that is not an object is recorded as { input }, never dropped
    await hooks.after_tool_call({ toolName: "shell", params: "ls" as unknown as Record<string, unknown>, toolCallId: "call-4", result: "" }, ctx);
    const names: string[] = [];
    registerOpenClaw({ on: (name) => names.push(name) }, issuer);
    expect(names).toEqual(["before_tool_call", "after_tool_call"]);
  });
});

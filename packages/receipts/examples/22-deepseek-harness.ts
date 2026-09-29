// Aspect: DeepSeek Harness plugin. Source: src/sdk/deepseek-harness.ts
// Run:    node examples/22-deepseek-harness.ts
//
// The harness runs two awaited waterfalls around each tool call: tools/pre-execute, where a handler may deny with a
// reason the model sees or delegate with next(), and tools/post-execute, which sees the result. The module is a plugin
// (name, inject, Config, apply); here a stand-in Cordis context drives it with the harness's own event shapes.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPublicKey } from "../src/crypto.ts";
import { apply, deepseekHarnessHooks, type DshPostToolDecision, type DshPreToolDecision } from "../src/sdk/deepseek-harness.ts";
import { verifyBundle } from "../src/verify.ts";
import { buildSdkFixture } from "../scripts/fixture.ts";
import { out, step } from "./_out.ts";

const fx = buildSdkFixture(out("22-deepseek-harness"), undefined, "deepseek-harness");

step(1, "the plugin's apply(ctx, config) registers both events on the context, as the harness would call it");
const handlers = new Map<string, (...a: any[]) => unknown>();
apply({ on: (event, handler) => handlers.set(event, handler) }, { config: fx.configFile });
console.log("   registered:", [...handlers.keys()].join(", "));
const pre = handlers.get("tools/pre-execute")! as ReturnType<typeof deepseekHarnessHooks>["preExecute"];
const post = handlers.get("tools/post-execute")! as ReturnType<typeof deepseekHarnessHooks>["postExecute"];
const agent = { session: { header: { id: "sess-42" } } };
const allow = async (): Promise<DshPreToolDecision> => ({ kind: "allow" });
const accept = async (): Promise<DshPostToolDecision> => ({ kind: "accept" });

step(2, "tools/pre-execute with a call the policy allows: delegated to next(), so the harness's own approvals still apply");
console.log("   decision:", JSON.stringify(await pre({ name: "stripe.refund", arguments: { amount: 100 }, callId: "call-1", agent }, allow)));

step(3, "tools/pre-execute with a call the policy denies: denied, with the receipt id in the reason the model sees");
const denied = await pre({ name: "stripe.refund", arguments: { amount: 999999 }, callId: "call-2", agent }, allow);
console.log("   decision:", JSON.stringify(denied));

step(4, "tools/post-execute for the call that ran, and for one that failed");
console.log("   decision:", JSON.stringify(await post({ name: "stripe.refund", arguments: { amount: 100 }, callId: "call-1", agent }, { isError: false, value: { refund_id: "re_1" }, content: [{ type: "text", text: '{"refund_id":"re_1"}' }] }, accept)));
console.log("   decision:", JSON.stringify(await post({ name: "customer.lookup", arguments: { id: "c9" }, callId: "call-3", agent }, { isError: true, error: { message: "upstream timeout" }, content: [] }, accept)));

step(5, "every receipt verifies with the application's public key and carries the harness's session and call ids");
const key = loadPublicKey(fx.appPub);
for (const f of readdirSync(fx.receiptsDir).filter((n) => n.endsWith(".json")).sort()) {
  const r = await verifyBundle(JSON.parse(readFileSync(join(fx.receiptsDir, f), "utf8")), { issuerKeys: [key], principalKeys: [], logFile: fx.logFile });
  const p = r.statement!.predicate;
  console.log(`   ${r.ok ? "VERIFIED" : "FAILED"}  ${p.tool.name.padEnd(16)} ${p.execution.status.padEnd(9)} session ${p.session.id} call ${p.session.toolUseId}`);
  if (!r.ok) throw new Error(`receipt ${f} does not verify`);
}
if (denied.kind !== "deny" || !/receipt [0-9a-f-]{36}/.test(denied.reason)) throw new Error("the denial did not carry a receipt id");

console.log("\nOK");

// Aspect: OpenClaw plugin hooks. Source: src/sdk/openclaw.ts
// Run:    node examples/21-openclaw.ts
//
// OpenClaw runs plugins in the agent's process and awaits two tool hooks: before_tool_call, which can block with a
// reason the model sees, and after_tool_call, which carries the result or error. The adapter is driven here with the
// event shapes OpenClaw's hook-types.ts declares, as a plugin host would call them.
import { loadSdkConfig } from "../src/config.ts";
import { createSdkIssuer } from "../src/sdk/index.ts";
import { openclawHooks, registerOpenClaw } from "../src/sdk/openclaw.ts";
import { verifyBundle } from "../src/verify.ts";
import { loadPublicKey } from "../src/crypto.ts";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSdkFixture } from "../scripts/fixture.ts";
import { out, step } from "./_out.ts";

const fx = buildSdkFixture(out("21-openclaw"), undefined, "openclaw");
const issuer = createSdkIssuer(loadSdkConfig(fx.configFile));
const hooks = openclawHooks(issuer);
const ctx = { agentId: "main", sessionKey: "agent:main:discord:dm", sessionId: "sess-1", runId: "run-1" };

step(1, "the plugin entry registers both hooks with api.on; a stand-in api records what was registered");
const registered: string[] = [];
registerOpenClaw({ on: (name) => registered.push(name) }, issuer);
console.log("   registered:", registered.join(", "));

step(2, "before_tool_call with a call the policy allows: no result, so OpenClaw's own approvals still apply");
console.log("   result:", JSON.stringify(await hooks.before_tool_call({ toolName: "stripe.refund", params: { amount: 100 }, toolCallId: "call-1" }, ctx)));

step(3, "before_tool_call with a call the policy denies: blocked, with the receipt id in the reason the model sees");
const blocked = await hooks.before_tool_call({ toolName: "stripe.refund", params: { amount: 999999 }, toolCallId: "call-2" }, ctx);
console.log("   result:", JSON.stringify(blocked));

step(4, "after_tool_call for the call that ran, and for one that errored");
await hooks.after_tool_call({ toolName: "stripe.refund", params: { amount: 100 }, toolCallId: "call-1", result: { refund_id: "re_1" }, durationMs: 42 }, ctx);
await hooks.after_tool_call({ toolName: "customer.lookup", params: { id: "c9" }, toolCallId: "call-3", error: "upstream timeout" }, ctx);

step(5, "every receipt verifies with the application's public key, and says what happened");
const key = loadPublicKey(join(fx.dir, "keys", "app.pub"));
for (const f of readdirSync(fx.receiptsDir).filter((n) => n.endsWith(".json")).sort()) {
  const bundle = JSON.parse(readFileSync(join(fx.receiptsDir, f), "utf8"));
  const r = await verifyBundle(bundle, { issuerKeys: [key], principalKeys: [], logFile: fx.logFile });
  const p = r.statement!.predicate;
  console.log(`   ${r.ok ? "VERIFIED" : "FAILED"}  ${p.tool.name.padEnd(16)} ${p.execution.status.padEnd(9)} session ${p.session.id} call ${p.session.toolUseId}`);
  if (!r.ok) throw new Error(`receipt ${f} does not verify`);
}
if (!blocked || !blocked.block || !/receipt [0-9a-f-]{36}/.test(blocked.blockReason)) throw new Error("the denial did not block with a receipt id");

console.log("\nOK");

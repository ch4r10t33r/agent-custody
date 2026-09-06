// Aspect: Claude Code and Claude Agent SDK hooks. Source: src/sdk/claude.ts, src/cli.ts (hook)
// Run:    node examples/08-claude-code-hook.ts
//
// Claude Code runs a command hook with the event as JSON on stdin. The same handler serves the Agent SDK in-process.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { loadSdkConfig } from "../src/config.ts";
import { claudeAgentHooks, handleHookEvent } from "../src/sdk/claude.ts";
import { createSdkIssuer } from "../src/sdk/index.ts";
import { buildSdkFixture } from "../scripts/fixture.ts";
import { out, step } from "./_out.ts";

const fx = buildSdkFixture(out("08-hook"), undefined, "claude-code");
const issuer = createSdkIssuer(loadSdkConfig(fx.configFile));

step(1, "register the hook in .claude/settings.json (one command for all three events)");
console.log(
  JSON.stringify(
    { hooks: { PreToolUse: [{ matcher: "mcp__.*", hooks: [{ type: "command", command: "node /abs/agent-custody/src/cli.ts hook --config /abs/sdk.json" }] }], PostToolUse: [{ hooks: [{ type: "command", command: "node /abs/agent-custody/src/cli.ts hook --config /abs/sdk.json" }] }] } },
    null,
    2,
  )
    .split("\n")
    .map((l) => "   " + l)
    .join("\n"),
);

step(2, "PreToolUse with a call the policy allows: no decision, so Claude Code's own permission prompt still applies");
console.log("   output:", JSON.stringify(await handleHookEvent(issuer, { hook_event_name: "PreToolUse", session_id: "s1", tool_use_id: "t1", tool_name: "stripe.refund", tool_input: { amount: 100 } })));

step(3, "PreToolUse with a call the policy denies: blocked, with the receipt id in the reason");
console.log("   output:", JSON.stringify(await handleHookEvent(issuer, { hook_event_name: "PreToolUse", session_id: "s1", tool_use_id: "t2", tool_name: "stripe.refund", tool_input: { amount: 999999 } })));

step(4, "PostToolUse: the executed receipt, carrying tool_response");
console.log("   output:", JSON.stringify(await handleHookEvent(issuer, { hook_event_name: "PostToolUse", session_id: "s1", tool_use_id: "t1", tool_name: "stripe.refund", tool_input: { amount: 100 }, tool_response: { refund_id: "re_1" } })));

step(5, "the real command path: the CLI reads the event from stdin");
const r = spawnSync(process.execPath, [resolve(import.meta.dirname, "..", "src", "cli.ts"), "hook", "--config", fx.configFile], {
  input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "stripe.refund", tool_input: { amount: 999999 } }),
  encoding: "utf8",
});
console.log("   exit:", r.status, "stdout:", r.stdout.trim());

step(6, "the Claude Agent SDK takes the same handler in-process: query({ options: { hooks: claudeAgentHooks(issuer) } })");
console.log("   events registered:", Object.keys(claudeAgentHooks(issuer)).join(", "));

console.log("\nOK");

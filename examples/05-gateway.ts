// Aspect: the gateway as an MCP server. Source: src/gateway.ts, src/cli.ts
// Run:    node examples/05-gateway.ts
//
// An agent host spawns the gateway exactly as it would spawn any stdio MCP server. The gateway spawns the real
// upstream behind it. This example is the agent: an MCP client that lists tools and calls two of them.
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { buildFixture } from "../scripts/fixture.ts";
import { out, step } from "./_out.ts";

const fx = buildFixture(out("05-gateway"));

step(1, "the fixture wrote keys, a grant, a policy, and gateway.json; the upstream is scripts/fake-stripe.ts");
console.log("   config:", fx.configFile);

step(2, "connect to the gateway over stdio, the way Claude Desktop or Claude Code would");
const agent = new Client({ name: "example-agent", version: "0.0.0" });
await agent.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", resolve(import.meta.dirname, "..", "src", "cli.ts"), "gateway", "--config", fx.configFile],
    stderr: "inherit",
  }),
);

step(3, "the tool list is the upstream's, filtered to the grant's scopes (stripe.payout exists upstream but is hidden)");
console.log("   tools:", (await agent.listTools()).tools.map((t) => t.name).join(", "));

step(4, "an in-policy refund executes; the receipt id comes back in _meta");
const ok = (await agent.callTool({ name: "stripe.refund", arguments: { customer_id: "cust_123", amount: 50000 } })) as CallToolResult;
console.log("   isError:", ok.isError ?? false, "receipt:", ok._meta?.["agent-receipts/receipt"]);

step(5, "an out-of-policy refund is refused before it reaches upstream, and still gets a receipt");
const denied = (await agent.callTool({ name: "stripe.refund", arguments: { customer_id: "cust_999", amount: 50000 } })) as CallToolResult;
console.log("   isError:", denied.isError, (denied.content[0] as { text: string }).text);

await agent.close();
console.log("\n   receipts are in", fx.receiptsDir, "and the log is", fx.logFile);
console.log("OK");

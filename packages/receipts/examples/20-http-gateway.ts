// Aspect: one gateway for many agents, over HTTP. Source: src/gateway-http.ts, src/gateway.ts
// Run:    node examples/20-http-gateway.ts
//
// A platform team runs one gateway in front of the tools. Every agent connects with MCP over Streamable HTTP and
// presents the grant its principal signed; the gateway opens a session for that grant and nothing else. Two agents
// here: one may refund, one may only look. Each gets its own tools, its own receipts, and a refusal for what its grant
// does not name; a third, whose grant was signed by a key the gateway does not trust, never gets a session.
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../src/config.ts";
import { generateKeyPair, loadPrivateKey } from "../src/crypto.ts";
import { createDelegation } from "../src/delegation.ts";
import { createGatewayHost, RECEIPT_META_KEY } from "../src/gateway.ts";
import { grantHeader, serveHttp } from "../src/gateway-http.ts";
import { buildFixture } from "../scripts/fixture.ts";
import { out, step } from "./_out.ts";

step(1, "one gateway host from gateway.json, served over HTTP on a free port");
const fx = buildFixture(out("20-http-gateway"));
const host = await createGatewayHost(loadConfig(fx.configFile));
const running = await serveHttp(host, { port: 0, log: () => {} });
console.log("   gateway:", running.url);

step(2, "the principal signs two grants: refund-agent may refund and look, read-agent may only look");
const principal = loadPrivateKey(join(fx.dir, "keys", "principal.key"));
const grant = (agent: string, scopes: string[], key = principal) => createDelegation(key, { version: "0.1", principal: "user_456", agent, scopes, issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString() });
const connect = async (agent: string, scopes: string[], key = principal) => {
  const client = new Client({ name: agent, version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(running.url), { requestInit: { headers: { authorization: `Bearer ${grantHeader(grant(agent, scopes, key))}` } } }));
  return client;
};
const refunder = await connect("refund-agent", ["stripe.refund", "customer.lookup"]);
const reader = await connect("read-agent", ["customer.lookup"]);
console.log("   refund-agent sees:", (await refunder.listTools()).tools.map((t) => t.name).join(", "));
console.log("   read-agent sees:  ", (await reader.listTools()).tools.map((t) => t.name).join(", "));

step(3, "each calls; the receipts name the right agent, and the reader's refund is refused by its own grant");
const ok = (await refunder.callTool({ name: "stripe.refund", arguments: { customer_id: "cust_123", amount: 2500 } })) as CallToolResult;
const denied = (await reader.callTool({ name: "stripe.refund", arguments: { customer_id: "cust_123", amount: 2500 } })) as CallToolResult;
const who = (r: CallToolResult) => {
  const b = JSON.parse(readFileSync(join(fx.receiptsDir, `${String(r._meta?.[RECEIPT_META_KEY])}.json`), "utf8"));
  const p = JSON.parse(Buffer.from(b.envelope.payload, "base64").toString()).predicate;
  return `${p.agent.id} -> ${p.execution.status}`;
};
console.log("   ", who(ok));
console.log("   ", who(denied), "|", (denied.content[0] as { text: string }).text.slice(0, 70));

step(4, "a grant signed by a key the gateway does not trust gets no session at all");
let refused = "";
try {
  await connect("stranger", ["stripe.refund"], generateKeyPair());
} catch (e) {
  refused = e instanceof Error ? e.message : String(e);
}
console.log("   stranger:", refused.includes("delegation grant rejected") ? "no session; the gateway answered 403, delegation grant rejected" : refused.slice(0, 80));

await refunder.close();
await reader.close();
await running.close();
await host.close();
if (ok.isError || !denied.isError || !refused.includes("delegation grant rejected") || who(ok) !== "refund-agent -> executed") throw new Error("unexpected state");
console.log("\nOK");

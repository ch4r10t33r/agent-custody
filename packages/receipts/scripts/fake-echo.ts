// A second stand-in upstream with one tool, for gateways that front several upstreams at once.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "fake-echo", version: "0.0.1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo.say", description: "Echo the input", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }): Promise<CallToolResult> => ({ content: [{ type: "text", text: JSON.stringify({ said: (params.arguments as { text?: string } | undefined)?.text ?? "" }) }] }));
await server.connect(new StdioServerTransport());

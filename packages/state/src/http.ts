// The memory server over HTTP: one ledger shared by several gateways and, if allowed, direct writers. This is what
// makes quarantine a live deployment: attested writes arrive through gateways, self-reported ones directly, and the
// ledger tells them apart. Stateless Streamable HTTP, one MCP server instance per request over the shared ledger.
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Ledger } from "./ledger.ts";
import { createMemoryServer, type MemoryServerOptions } from "./server.ts";

export interface MemoryHttpOptions extends MemoryServerOptions {
  port: number;
  host?: string;
  /** bearer tokens accepted; when empty, anyone who can reach the port may call */
  tokens?: string[];
}

export interface RunningMemoryServer {
  url: string;
  close(): Promise<void>;
}

export function memoryHttpHandler(ledger: Ledger, opts: MemoryHttpOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const tokens = opts.tokens ?? [];
  const authorized = (req: IncomingMessage) => {
    if (tokens.length === 0) return true;
    const h = req.headers.authorization ?? "";
    const given = Buffer.from(h.startsWith("Bearer ") ? h.slice(7) : "");
    return tokens.some((t) => Buffer.from(t).length === given.length && timingSafeEqual(Buffer.from(t), given));
  };
  return async (req, res) => {
    if (!authorized(req)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = createMemoryServer(ledger, opts);
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };
}

/** Starts the memory server over HTTP. Port 0 picks a free port. Host defaults to loopback; bind wider only behind auth. */
export function serveMemoryHttp(ledger: Ledger, opts: MemoryHttpOptions): Promise<RunningMemoryServer> {
  const host = opts.host ?? "127.0.0.1";
  const handler = memoryHttpHandler(ledger, opts);
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(opts.port, host, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://${host}:${port}/mcp`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

// Write-through, against the real client packages and a fake endpoint for each vendor. No network: the fakes record
// what the clients send and answer the way the services do. What matters is that a fact reaches the store with its
// custody metadata, its store id is recorded on the fact, and a retraction reaches the store.
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MemoryClient } from "mem0ai";
import { ZepClient } from "@getzep/zep-cloud";
import { Ledger } from "../src/ledger.ts";
import { createMemoryServer } from "../src/server.ts";
import { mem0Store, zepStore } from "../src/stores.ts";

interface Seen { method: string; path: string; body: any; auth: string | undefined }
function fake(routes: (req: Seen) => { status: number; body: unknown } | undefined): Promise<{ url: string; seen: Seen[]; close(): void; fail: { on: boolean } }> {
  const seen: Seen[] = [];
  const fail = { on: false };
  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const s: Seen = { method: req.method!, path: req.url!, body: raw ? JSON.parse(raw) : null, auth: req.headers.authorization };
    seen.push(s);
    const r = fail.on ? { status: 500, body: { error: "store down" } } : (routes(s) ?? { status: 404, body: { error: "no route" } });
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(JSON.stringify(r.body));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as any).port}`, seen, close: () => server.close(), fail })));
}

describe("write-through stores", () => {
  let mem0: Awaited<ReturnType<typeof fake>>;
  let zep: Awaited<ReturnType<typeof fake>>;
  let client: Client;
  let ledger: Ledger;

  beforeAll(async () => {
    process.env.MEM0_TELEMETRY = "false";
    mem0 = await fake((r) => {
      if (r.method === "GET" && r.path === "/v1/ping/") return { status: 200, body: { status: "ok", org_id: "org_1", project_id: "proj_1" } };
      if (r.method === "POST" && r.path === "/v3/memories/add/") return { status: 200, body: [{ id: "mem_1", memory: r.body.messages[0].content, event: "ADD" }] };
      if (r.method === "DELETE" && /^\/v1\/memories\/[^/]+\/$/.test(r.path)) return { status: 200, body: { message: "Memory deleted successfully!" } };
      return undefined;
    });
    zep = await fake((r) => {
      if (r.method === "POST" && r.path === "/graph") return { status: 200, body: { uuid: "ep_1", content: r.body.data, created_at: new Date().toISOString(), processed: false } };
      if (r.method === "DELETE" && /^\/graph\/episodes\/[^/]+$/.test(r.path)) return { status: 200, body: { message: "deleted" } };
      return undefined;
    });
    ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "stores-")), "ledger.jsonl"));
    const stores = [mem0Store(new MemoryClient({ apiKey: "test-key", host: mem0.url }), { userId: "user_42" }), zepStore(new ZepClient({ apiKey: "test-key", baseUrl: zep.url }), { userId: "user_42" })];
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMemoryServer(ledger, { stores }).connect(a);
    client = new Client({ name: "test", version: "0" });
    await client.connect(b);
  });
  afterAll(async () => {
    await client.close();
    mem0.close();
    zep.close();
  });

  const value = (r: CallToolResult) => JSON.parse((r.content[0] as { text: string }).text);

  it("a write reaches both stores with the fact's custody metadata, and both ids are recorded on the fact", async () => {
    const r = value((await client.callTool({ name: "memory.write", arguments: { subject: "acct:42", predicate: "plan", value: "pro", space: "team:support", actor: "support-agent" } })) as CallToolResult);
    expect(r.fact.external).toEqual({ mem0: "mem_1", zep: "ep_1" });
    const add = mem0.seen.find((s) => s.path === "/v3/memories/add/")!;
    expect(add.auth).toBe("Token test-key");
    expect(add.body.messages).toEqual([{ role: "user", content: "acct:42 plan: pro" }]);
    expect(add.body.user_id).toBe("user_42");
    expect(add.body.infer).toBe(false);
    expect(add.body.metadata).toMatchObject({ space: "team:support", actor: "support-agent", provenance: "claimed", source: "agent-custody" });
    const graph = zep.seen.find((s) => s.path === "/graph")!;
    expect(graph.body.user_id).toBe("user_42");
    expect(graph.body.type).toBe("json");
    expect(JSON.parse(graph.body.data)).toMatchObject({ subject: "acct:42", predicate: "plan", value: "pro", space: "team:support" });
    expect(graph.body.source_description).toBe("agent-custody");
    expect(new Ledger(ledger["file" as keyof Ledger] as unknown as string).asOf()[0]?.external).toEqual({ mem0: "mem_1", zep: "ep_1" });
  });

  it("a retraction reaches both stores by the recorded ids", async () => {
    const factId = ledger.asOf()[0]!.factId;
    const r = value((await client.callTool({ name: "memory.retract", arguments: { factId, reason: "wrong" } })) as CallToolResult);
    expect(r.removedFrom.sort()).toEqual(["mem0", "zep"]);
    expect(mem0.seen.some((s) => s.method === "DELETE" && s.path === "/v1/memories/mem_1/")).toBe(true);
    expect(zep.seen.some((s) => s.method === "DELETE" && s.path === "/graph/episodes/ep_1")).toBe(true);
    expect(ledger.asOf()).toEqual([]);
  });

  it("a store that refuses the write fails the write and nothing is recorded anywhere", async () => {
    const before = ledger.size;
    zep.fail.on = true;
    const r = (await client.callTool({ name: "memory.write", arguments: { subject: "acct:43", predicate: "plan", value: "free", space: "team:support" } })) as CallToolResult;
    zep.fail.on = false;
    expect(r.isError).toBe(true);
    expect(ledger.size).toBe(before);
  });

  it("a write the ledger would refuse never reaches a store", async () => {
    const mem0Before = mem0.seen.length;
    const r = (await client.callTool({ name: "memory.write", arguments: { subject: "s", predicate: "p", value: 1, space: "team:support", supersedes: "no-such-fact" } })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(mem0.seen.length).toBe(mem0Before);
  });

  it("a retraction whose store removal fails is still retracted in the ledger, and says which store still holds it", async () => {
    const w = value((await client.callTool({ name: "memory.write", arguments: { subject: "acct:44", predicate: "plan", value: "pro", space: "team:support" } })) as CallToolResult);
    mem0.fail.on = true;
    const r = (await client.callTool({ name: "memory.retract", arguments: { factId: w.fact.factId, reason: "wrong" } })) as CallToolResult;
    mem0.fail.on = false;
    expect(r.isError).toBe(true);
    expect((r.content[0] as any).text).toMatch(/retracted in the ledger, but still held by mem0/);
    expect(ledger.asOf({ subject: "acct:44" })).toEqual([]);
    expect(JSON.parse((r.content[1] as any).text).removedFrom).toEqual(["zep"]);
  });

  it("forgetting erases the value from the ledger and removes it from both stores; the result is the certificate", async () => {
    const w = value((await client.callTool({ name: "memory.write", arguments: { subject: "person:9", predicate: "email", value: "dana@example.com", space: "team:support" } })) as CallToolResult);
    const r = value((await client.callTool({ name: "memory.forget", arguments: { factId: w.fact.factId, reason: "deletion request" } })) as CallToolResult);
    expect(r).toMatchObject({ factId: w.fact.factId, erasedFromLedger: true, stillHeld: [] });
    expect(r.removedFrom.sort()).toEqual(["mem0", "zep"]);
    expect(r.valueDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(ledger["file" as keyof Ledger] as unknown as string, "utf8")).not.toContain("dana@example.com");
    expect(mem0.seen.some((s) => s.method === "DELETE" && s.path === `/v1/memories/${w.fact.external.mem0}/`)).toBe(true);
    expect(zep.seen.some((s) => s.method === "DELETE" && s.path === `/graph/episodes/${w.fact.external.zep}`)).toBe(true);
  });
});

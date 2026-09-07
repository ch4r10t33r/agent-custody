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
/** A store index that keeps surfacing a deleted item for `lag` searches after the delete: the thing #10 exists to catch. */
function laggingIndex() {
  const live = new Map<string, string>();
  const stale = new Map<string, { text: string; left: number }>();
  const state = { lag: 1 };
  return {
    state,
    put(id: string, text: string) {
      live.set(id, text);
    },
    remove(id: string) {
      const text = live.get(id);
      live.delete(id);
      if (text !== undefined && state.lag > 0) stale.set(id, { text, left: state.lag });
    },
    search(): { id: string; text: string }[] {
      const hits = [...live].map(([id, text]) => ({ id, text }));
      for (const [id, s] of stale) {
        hits.push({ id, text: s.text });
        if (--s.left <= 0) stale.delete(id);
      }
      return hits;
    },
  };
}

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
  const mem0Index = laggingIndex();
  const zepIndex = laggingIndex();

  beforeAll(async () => {
    process.env.MEM0_TELEMETRY = "false";
    mem0 = await fake((r) => {
      if (r.method === "GET" && r.path === "/v1/ping/") return { status: 200, body: { status: "ok", org_id: "org_1", project_id: "proj_1" } };
      if (r.method === "POST" && r.path === "/v3/memories/add/") {
        const id = `mem_${mem0.seen.length}`;
        mem0Index.put(id, r.body.messages[0].content);
        return { status: 200, body: [{ id, memory: r.body.messages[0].content, event: "ADD" }] };
      }
      if (r.method === "DELETE" && /^\/v1\/memories\/[^/]+\/$/.test(r.path)) {
        mem0Index.remove(r.path.split("/")[3]!);
        return { status: 200, body: { message: "Memory deleted successfully!" } };
      }
      if (r.method === "POST" && r.path === "/v3/memories/search/") return { status: 200, body: { results: mem0Index.search().map((h) => ({ id: h.id, memory: h.text })) } };
      return undefined;
    });
    zep = await fake((r) => {
      if (r.method === "POST" && r.path === "/graph") {
        const uuid = `ep_${zep.seen.length}`;
        zepIndex.put(uuid, r.body.data);
        return { status: 200, body: { uuid, content: r.body.data, created_at: new Date().toISOString(), processed: false } };
      }
      if (r.method === "DELETE" && /^\/graph\/episodes\/[^/]+$/.test(r.path)) {
        zepIndex.remove(r.path.split("/")[3]!);
        return { status: 200, body: { message: "deleted" } };
      }
      if (r.method === "POST" && r.path === "/graph/search") return { status: 200, body: { episodes: zepIndex.search().map((h) => ({ uuid: h.id, content: h.text, created_at: new Date().toISOString() })), edges: [] } };
      return undefined;
    });
    ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "stores-")), "ledger.jsonl"));
    const stores = [mem0Store(new MemoryClient({ apiKey: "test-key", host: mem0.url }), { userId: "user_42" }), zepStore(new ZepClient({ apiKey: "test-key", baseUrl: zep.url }), { userId: "user_42" })];
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMemoryServer(ledger, { stores, verify: { attempts: 3, delayMs: 1 } }).connect(a);
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
    expect(Object.keys(r.fact.external).sort()).toEqual(["mem0", "zep"]);
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
    expect((await new Ledger(ledger.location).asOf())[0]?.external).toEqual(r.fact.external);
  });

  it("a retraction reaches both stores by the recorded ids", async () => {
    const fact = (await ledger.asOf())[0]!;
    const r = value((await client.callTool({ name: "memory.retract", arguments: { factId: fact.factId, reason: "wrong" } })) as CallToolResult);
    expect(r.removedFrom.sort()).toEqual(["mem0", "zep"]);
    expect(r.verification).toEqual({ mem0: "verified", zep: "verified" });
    expect(mem0.seen.some((s) => s.method === "DELETE" && s.path === `/v1/memories/${fact.external!.mem0}/`)).toBe(true);
    expect(zep.seen.some((s) => s.method === "DELETE" && s.path === `/graph/episodes/${fact.external!.zep}`)).toBe(true);
    expect(await ledger.asOf()).toEqual([]);
  });

  it("a store that refuses the write fails the write and nothing is recorded anywhere", async () => {
    const before = await ledger.count();
    zep.fail.on = true;
    const r = (await client.callTool({ name: "memory.write", arguments: { subject: "acct:43", predicate: "plan", value: "free", space: "team:support" } })) as CallToolResult;
    zep.fail.on = false;
    expect(r.isError).toBe(true);
    expect(await ledger.count()).toBe(before);
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
    expect(await ledger.asOf({ subject: "acct:44" })).toEqual([]);
    expect(JSON.parse((r.content[1] as any).text).removedFrom).toEqual(["zep"]);
  });

  it("forgetting erases the value from the ledger and removes it from both stores; the result is the certificate", async () => {
    const w = value((await client.callTool({ name: "memory.write", arguments: { subject: "person:9", predicate: "email", value: "dana@example.com", space: "team:support" } })) as CallToolResult);
    const r = value((await client.callTool({ name: "memory.forget", arguments: { factId: w.fact.factId, reason: "deletion request" } })) as CallToolResult);
    expect(r).toMatchObject({ factId: w.fact.factId, erasedFromLedger: true, stillHeld: [] });
    expect(r.removedFrom.sort()).toEqual(["mem0", "zep"]);
    expect(r.valueDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(ledger.location, "utf8")).not.toContain("dana@example.com");
    expect(mem0.seen.some((s) => s.method === "DELETE" && s.path === `/v1/memories/${w.fact.external.mem0}/`)).toBe(true);
    expect(zep.seen.some((s) => s.method === "DELETE" && s.path === `/graph/episodes/${w.fact.external.zep}`)).toBe(true);
  });

  it("a sweep through the server forgets old facts in the ledger and removes each from both stores, skipping a held one", async () => {
    const a = value((await client.callTool({ name: "memory.write", arguments: { subject: "old:1", predicate: "email", value: "old1@x", space: "team:support" } })) as CallToolResult);
    const b = value((await client.callTool({ name: "memory.write", arguments: { subject: "old:2", predicate: "email", value: "old2@x", space: "team:support" } })) as CallToolResult);
    value((await client.callTool({ name: "memory.hold", arguments: { factId: b.fact.factId, reason: "litigation" } })) as CallToolResult);
    const future = new Date(Date.now() + 60_000).toISOString();
    const r = value((await client.callTool({ name: "memory.sweep", arguments: { before: future, space: "team:support", reason: "retention" } })) as CallToolResult);
    expect(r.forgotten.map((f: any) => f.factId)).toContain(a.fact.factId);
    expect(r.held).toEqual([b.fact.factId]);
    expect(r.stillHeld).toEqual([]);
    expect(mem0.seen.some((s) => s.method === "DELETE" && s.path === `/v1/memories/${a.fact.external.mem0}/`)).toBe(true);
    expect(zep.seen.some((s) => s.method === "DELETE" && s.path === `/graph/episodes/${a.fact.external.zep}`)).toBe(true);
    expect(readFileSync(ledger.location, "utf8")).not.toContain("old1@x");
    expect(readFileSync(ledger.location, "utf8")).toContain("old2@x");
  });

  it("the forget result names the digest kind, and keepDigest false leaves none", async () => {
    const w = value((await client.callTool({ name: "memory.write", arguments: { subject: "p:8", predicate: "email", value: "x@y", space: "team:support" } })) as CallToolResult);
    const r = value((await client.callTool({ name: "memory.forget", arguments: { factId: w.fact.factId, reason: "request", keepDigest: false } })) as CallToolResult);
    expect(r).toMatchObject({ digestKind: "none", valueDigest: null, erasedFromLedger: true });
  });

  it("removal is verified against the store's search: an index that lags one search still verifies, one that never clears is reported as still indexed", async () => {
    mem0Index.state.lag = 1;
    zepIndex.state.lag = 99;
    const w = value((await client.callTool({ name: "memory.write", arguments: { subject: "p:11", predicate: "email", value: "lag@x", space: "team:support" } })) as CallToolResult);
    const r = value((await client.callTool({ name: "memory.forget", arguments: { factId: w.fact.factId, reason: "request" } })) as CallToolResult);
    expect(r.verification).toEqual({ mem0: "verified", zep: "stillIndexed" });
    expect(r.stillHeld).toEqual([]);
    expect(mem0.seen.filter((s) => s.path === "/v3/memories/search/").length).toBeGreaterThanOrEqual(2);
    zepIndex.state.lag = 1;
  });

  it("a store without search is reported as unverified, never verified", async () => {
    const calls: string[] = [];
    const blind = { name: "blind", async put() { calls.push("put"); return "b1"; }, async remove() { calls.push("remove"); } };
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMemoryServer(new Ledger(join(mkdtempSync(join(tmpdir(), "blind-")), "l.jsonl")), { stores: [blind] }).connect(a);
    const c = new Client({ name: "t", version: "0" });
    await c.connect(b);
    const w = value((await c.callTool({ name: "memory.write", arguments: { subject: "s", predicate: "p", value: 1, space: "org" } })) as CallToolResult);
    const r = value((await c.callTool({ name: "memory.forget", arguments: { factId: w.fact.factId, reason: "r" } })) as CallToolResult);
    expect(r.verification).toEqual({ blind: "unverified" });
    expect(calls).toEqual(["put", "remove"]);
    await c.close();
  });
});

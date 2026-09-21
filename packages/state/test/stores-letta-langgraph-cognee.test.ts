// Write-through to Letta, a LangGraph store (where LangMem keeps its memories), and Cognee. Letta is driven through
// its real client against a stand-in of its archival-memory routes; the LangGraph store is the real InMemoryStore,
// no network at all; Cognee has no JavaScript client, so the adapter's own HTTP is checked against a stand-in of the
// three routes it uses. In every case: a fact reaches the store with its custody, the store's id is recorded on the
// fact, retraction and forget reach the store and are verified, and a store that refuses fails the write cleanly.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Letta } from "@letta-ai/letta-client";
import { InMemoryStore } from "@langchain/langgraph";
import { Ledger } from "../src/ledger.ts";
import { createMemoryServer } from "../src/server.ts";
import { cogneeStore, langgraphStore, lettaStore } from "../src/stores.ts";

interface Seen { method: string; path: string; body: string; headers: Record<string, string | string[] | undefined> }
function fake(routes: (req: Seen) => { status: number; body: unknown } | undefined): Promise<{ url: string; seen: Seen[]; close(): void; fail: { on: boolean } }> {
  const seen: Seen[] = [];
  const fail = { on: false };
  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const s: Seen = { method: req.method!, path: req.url!, body: raw, headers: req.headers };
    seen.push(s);
    const r = fail.on ? { status: 500, body: { error: "store down" } } : (routes(s) ?? { status: 404, body: { error: `no route ${s.method} ${s.path}` } });
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(JSON.stringify(r.body));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, close: () => server.close(), fail })));
}
const value = (r: CallToolResult) => JSON.parse((r.content[0] as { text: string }).text);

async function serverWith(stores: NonNullable<Parameters<typeof createMemoryServer>[1]>["stores"]) {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "stores3-")), "ledger.jsonl"));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMemoryServer(ledger, { stores, verify: { attempts: 3, delayMs: 1 } }).connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return { ledger, client };
}

describe("Letta archival memory, through the real client", () => {
  let letta: Awaited<ReturnType<typeof fake>>;
  const passages = new Map<string, { text: string; tags: string[] }>();
  let ctx: Awaited<ReturnType<typeof serverWith>>;
  beforeAll(async () => {
    letta = await fake((r) => {
      const m = r.path.match(/^\/v1\/agents\/([^/]+)\/archival-memory(\/search\?.*|\/([^/?]+))?$/);
      if (!m) return undefined;
      if (r.method === "POST" && !m[2]) {
        const b = JSON.parse(r.body) as { text: string; tags: string[] };
        const id = `passage-${passages.size + 1}`;
        passages.set(id, { text: b.text, tags: b.tags });
        return { status: 200, body: [{ id, text: b.text, tags: b.tags, agent_id: m[1], created_at: new Date().toISOString() }] };
      }
      if (r.method === "DELETE" && m[3]) {
        passages.delete(m[3]);
        return { status: 200, body: { message: "deleted" } };
      }
      if (r.method === "GET" && m[2]?.startsWith("/search")) {
        const results = [...passages].map(([id, p]) => ({ id, content: p.text, timestamp: new Date().toISOString(), tags: p.tags }));
        return { status: 200, body: { count: results.length, results } };
      }
      return undefined;
    });
    ctx = await serverWith([lettaStore(new Letta({ apiKey: "test-key", baseURL: letta.url }), { agentId: "agent-1", tags: ["support"] })]);
  });
  afterAll(async () => {
    await ctx.client.close();
    letta.close();
  });

  it("a write becomes a passage with the custody as tags, the passage id is on the fact, and retract and forget delete it and verify", async () => {
    const w = value((await ctx.client.callTool({ name: "memory.write", arguments: { subject: "acct:42", predicate: "plan", value: "pro", space: "team:support", actor: "support-agent" } })) as CallToolResult);
    expect(w.fact.external).toEqual({ letta: "passage-1" });
    const create = letta.seen.find((s) => s.method === "POST")!;
    expect(create.headers.authorization).toBe("Bearer test-key");
    const body = JSON.parse(create.body);
    expect(body.text).toBe("acct:42 plan: pro");
    expect(body.tags).toEqual(["agent-custody", `fact:${w.fact.factId}`, "space:team:support", "support"]);
    const r = value((await ctx.client.callTool({ name: "memory.retract", arguments: { factId: w.fact.factId, reason: "wrong" } })) as CallToolResult);
    expect(r).toMatchObject({ removedFrom: ["letta"], verification: { letta: "verified" } });
    expect(letta.seen.some((s) => s.method === "DELETE" && s.path === "/v1/agents/agent-1/archival-memory/passage-1")).toBe(true);
    const w2 = value((await ctx.client.callTool({ name: "memory.write", arguments: { subject: "person:1", predicate: "email", value: "d@example.com", space: "team:support", actor: "support-agent" } })) as CallToolResult);
    const fg = value((await ctx.client.callTool({ name: "memory.forget", arguments: { factId: w2.fact.factId, reason: "deletion request" } })) as CallToolResult);
    expect(fg).toMatchObject({ erasedFromLedger: true, removedFrom: ["letta"], verification: { letta: "verified" } });
    expect(passages.size).toBe(0);
  });

  it("a refusing Letta fails the write and nothing is recorded", async () => {
    const before = await ctx.ledger.count();
    letta.fail.on = true;
    try {
      const r = (await ctx.client.callTool({ name: "memory.write", arguments: { subject: "acct:43", predicate: "plan", value: "free", space: "team:support", actor: "support-agent" } })) as CallToolResult;
      expect(r.isError).toBe(true);
      expect(await ctx.ledger.count()).toBe(before);
    } finally {
      letta.fail.on = false;
    }
  });
});

describe("a LangGraph store, where LangMem keeps its memories, the real InMemoryStore", () => {
  const store = new InMemoryStore();
  let ctx: Awaited<ReturnType<typeof serverWith>>;
  beforeAll(async () => {
    ctx = await serverWith([langgraphStore(store, { namespace: ["memories", "user_42"] })]);
  });
  afterAll(async () => {
    await ctx.client.close();
  });

  it("a write is one item keyed by the fact id with content and custody, and retract and forget remove it, verified by get and search", async () => {
    const w = value((await ctx.client.callTool({ name: "memory.write", arguments: { subject: "acct:42", predicate: "plan", value: "pro", space: "team:support", actor: "support-agent" } })) as CallToolResult);
    expect(w.fact.external).toEqual({ langgraph: w.fact.factId });
    const item = await store.get(["memories", "user_42"], w.fact.factId);
    expect(item?.value).toMatchObject({ content: "acct:42 plan: pro", subject: "acct:42", predicate: "plan", value: "pro", space: "team:support", actor: "support-agent", provenance: "claimed", source: "agent-custody" });
    expect((await store.search(["memories", "user_42"], { filter: { factId: w.fact.factId } })).map((h) => h.key)).toEqual([w.fact.factId]);
    const r = value((await ctx.client.callTool({ name: "memory.retract", arguments: { factId: w.fact.factId, reason: "wrong" } })) as CallToolResult);
    expect(r).toMatchObject({ removedFrom: ["langgraph"], verification: { langgraph: "verified" } });
    expect(await store.get(["memories", "user_42"], w.fact.factId)).toBeNull();
    const w2 = value((await ctx.client.callTool({ name: "memory.write", arguments: { subject: "person:1", predicate: "ssn", value: "SSN-1", space: "team:support", actor: "support-agent" } })) as CallToolResult);
    const fg = value((await ctx.client.callTool({ name: "memory.forget", arguments: { factId: w2.fact.factId, reason: "deletion request" } })) as CallToolResult);
    expect(fg).toMatchObject({ erasedFromLedger: true, removedFrom: ["langgraph"], verification: { langgraph: "verified" } });
    expect(await store.search(["memories", "user_42"])).toEqual([]);
  });
});

describe("Cognee, through its REST API", () => {
  let cognee: Awaited<ReturnType<typeof fake>>;
  const items: { id: string; name: string; external_metadata: string }[] = [];
  let ctx: Awaited<ReturnType<typeof serverWith>>;
  beforeAll(async () => {
    process.env.TEST_COGNEE_KEY = "cognee-key";
    cognee = await fake((r) => {
      if (r.method === "POST" && r.path === "/api/v1/add") {
        // multipart: the fields arrive as parts; keep what the adapter sent so the test can assert on it
        const field = (name: string) => r.body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`))?.[1] ?? null;
        const meta = JSON.parse(field("external_metadata") ?? "[]")[0];
        items.push({ id: `data-${items.length + 1}`, name: field("raw_data") ?? "", external_metadata: JSON.stringify(meta) });
        return { status: 200, body: { pipeline_run_id: "run-1", status: "DATASET_PROCESSING_COMPLETED", dataset_id: "ds-1" } };
      }
      if (r.method === "GET" && r.path === "/api/v1/datasets/ds-1/data") return { status: 200, body: items };
      const del = r.path.match(/^\/api\/v1\/datasets\/ds-1\/data\/([^/]+)$/);
      if (r.method === "DELETE" && del) {
        const i = items.findIndex((x) => x.id === del[1]);
        if (i >= 0) items.splice(i, 1);
        return { status: 200, body: {} };
      }
      return undefined;
    });
    ctx = await serverWith([cogneeStore({ url: cognee.url, datasetId: "ds-1", apiKeyEnv: "TEST_COGNEE_KEY" })]);
  });
  afterAll(async () => {
    await ctx.client.close();
    cognee.close();
  });

  it("a write is a multipart add with the text, dataset, and custody metadata; the data id is found by listing; retract and forget delete it and verify", async () => {
    const w = value((await ctx.client.callTool({ name: "memory.write", arguments: { subject: "acct:42", predicate: "plan", value: "pro", space: "team:support", actor: "support-agent" } })) as CallToolResult);
    expect(w.fact.external).toEqual({ cognee: "data-1" });
    const add = cognee.seen.find((s) => s.path === "/api/v1/add")!;
    expect(add.headers["x-api-key"]).toBe("cognee-key");
    expect(String(add.headers["content-type"])).toMatch(/^multipart\/form-data; boundary=/);
    expect(add.body).toContain('name="raw_data"\r\n\r\nacct:42 plan: pro');
    expect(add.body).toContain('name="datasetId"\r\n\r\nds-1');
    expect(add.body).toMatch(/name="external_metadata"\r\n\r\n\[\{"factId":"[^"]+","space":"team:support"/);
    const r = value((await ctx.client.callTool({ name: "memory.retract", arguments: { factId: w.fact.factId, reason: "wrong" } })) as CallToolResult);
    expect(r).toMatchObject({ removedFrom: ["cognee"], verification: { cognee: "verified" } });
    expect(cognee.seen.some((s) => s.method === "DELETE" && s.path === "/api/v1/datasets/ds-1/data/data-1")).toBe(true);
    const w2 = value((await ctx.client.callTool({ name: "memory.write", arguments: { subject: "person:1", predicate: "email", value: "d@example.com", space: "team:support", actor: "support-agent" } })) as CallToolResult);
    const fg = value((await ctx.client.callTool({ name: "memory.forget", arguments: { factId: w2.fact.factId, reason: "deletion request" } })) as CallToolResult);
    expect(fg).toMatchObject({ erasedFromLedger: true, removedFrom: ["cognee"], verification: { cognee: "verified" } });
    expect(items).toEqual([]);
  });

  it("a missing credential variable fails at construction, and a refusing Cognee fails the write with nothing recorded", async () => {
    expect(() => cogneeStore({ url: cognee.url, datasetId: "ds-1", apiKeyEnv: "NOT_SET_ANYWHERE_COGNEE" })).toThrow(/NOT_SET_ANYWHERE_COGNEE/);
    const before = await ctx.ledger.count();
    cognee.fail.on = true;
    try {
      const r = (await ctx.client.callTool({ name: "memory.write", arguments: { subject: "acct:43", predicate: "plan", value: "free", space: "team:support", actor: "support-agent" } })) as CallToolResult;
      expect(r.isError).toBe(true);
      expect(await ctx.ledger.count()).toBe(before);
    } finally {
      cognee.fail.on = false;
    }
  });
});

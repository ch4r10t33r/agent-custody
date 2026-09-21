// Write-through to the retrieval stores teams already use. The ledger keeps provenance, time, and undo; the store
// keeps serving recall. A fact written through the memory server lands in every configured store, the store's id is
// recorded on the fact, and a retraction reaches the store. Clients are typed structurally, as the receipts adapters
// are, so this package has no runtime dependency on either vendor; the tests run against the real client packages.
import type { Fact } from "./ledger.ts";

export interface Store {
  /** the key under which the store's id is recorded on the fact */
  readonly name: string;
  /** writes the fact and returns the store's own id for it */
  put(fact: Fact): Promise<string>;
  /** removes the fact from the store; called on retraction and forget */
  remove(externalId: string, fact: Fact): Promise<void>;
  /**
   * Checks the store's own search no longer surfaces the fact: a delete by id and a search index catching up are
   * different moments. Optional; a store without it is reported as unverified, never as verified.
   */
  verifyRemoved?(externalId: string, fact: Fact): Promise<boolean>;
}

/** What the server reports per store after a removal. */
export type RemovalOutcome = "verified" | "stillIndexed" | "unverified" | "failed";

/** One line a retrieval store can index: what the fact says, in words. */
export function factText(f: Fact): string {
  return `${f.subject} ${f.predicate}: ${typeof f.value === "string" ? f.value : JSON.stringify(f.value)}`;
}

/** Metadata every store receives alongside the text, so a memory can always be traced back to its custody. */
export function factMetadata(f: Fact): Record<string, unknown> {
  return { factId: f.factId, space: f.space, actor: f.actor, provenance: f.provenance, receiptId: f.source.receiptId, validFrom: f.validFrom, source: "agent-custody" };
}

// ---- Mem0 ----
/** The subset of mem0ai's MemoryClient this adapter uses. */
export interface Mem0Like {
  add(messages: { role: "user" | "assistant"; content: string }[], options?: Record<string, unknown>): Promise<{ id?: string }[]>;
  delete(memoryId: string): Promise<unknown>;
  search?(query: string, options?: Record<string, unknown>): Promise<{ results: { id?: string; memory?: string }[] }>;
}

export interface Mem0Options {
  userId: string;
  /** Mem0 extracts memories with an LLM when infer is true. Off by default, so the memory is the fact, verbatim. */
  infer?: boolean;
}

export function mem0Store(client: Mem0Like, opts: Mem0Options): Store {
  return {
    name: "mem0",
    async put(fact) {
      const results = await client.add([{ role: "user", content: factText(fact) }], { user_id: opts.userId, infer: opts.infer ?? false, metadata: factMetadata(fact) });
      const id = results.find((r) => typeof r.id === "string")?.id;
      if (!id) throw new Error("mem0 returned no memory id");
      return id;
    },
    async remove(externalId) {
      await client.delete(externalId);
    },
    ...(client.search
      ? {
          async verifyRemoved(externalId, fact) {
            // Mem0's search scopes by filters, not by top-level entity parameters; the real client refuses the latter.
            const { results } = await client.search!(factText(fact), { filters: { user_id: opts.userId } });
            return !results.some((r) => r.id === externalId || r.memory === factText(fact));
          },
        }
      : {}),
  };
}

// ---- Zep ----
/** The subset of @getzep/zep-cloud's ZepClient this adapter uses. */
export interface ZepLike {
  graph: {
    add(request: { userId?: string; graphId?: string; type: "json" | "text"; data: string; sourceDescription?: string; metadata?: Record<string, unknown> }): Promise<{ uuid: string }>;
    episode: { delete(uuid: string): Promise<unknown> };
    search?(request: { userId?: string; graphId?: string; query: string; limit?: number }): Promise<{ edges?: { uuid: string; fact: string; episodes?: string[] }[]; episodes?: { uuid: string; content: string }[] }>;
  };
}

export type ZepOptions = { userId: string; graphId?: undefined } | { graphId: string; userId?: undefined };

export function zepStore(client: ZepLike, opts: ZepOptions): Store {
  return {
    name: "zep",
    async put(fact) {
      const target = opts.graphId ? { graphId: opts.graphId } : { userId: opts.userId! };
      const episode = await client.graph.add({ ...target, type: "json", data: JSON.stringify({ subject: fact.subject, predicate: fact.predicate, value: fact.value, ...factMetadata(fact) }), sourceDescription: "agent-custody", metadata: factMetadata(fact) });
      if (!episode?.uuid) throw new Error("zep returned no episode uuid");
      return episode.uuid;
    },
    async remove(externalId) {
      await client.graph.episode.delete(externalId);
    },
    ...(client.graph.search
      ? {
          async verifyRemoved(externalId, fact) {
            const target = opts.graphId ? { graphId: opts.graphId } : { userId: opts.userId! };
            const r = await client.graph.search!({ ...target, query: factText(fact), limit: 20 });
            const episodeHit = (r.episodes ?? []).some((e) => e.uuid === externalId);
            const edgeHit = (r.edges ?? []).some((e) => (e.episodes ?? []).includes(externalId));
            return !episodeHit && !edgeHit;
          },
        }
      : {}),
  };
}

// ---- pgvector ----
/** What the pgvector adapter needs from a client: the query method of a pg Pool or of PGlite. */
export interface PgLike {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface PgvectorOptions {
  /** turns the fact's text into the vector the table indexes; the same function the retrieval side uses */
  embed: (text: string) => Promise<number[]>;
  /** the vector's length, fixed per table */
  dimensions: number;
  /** table name, optionally schema-qualified; default "agent_memories"; created if missing */
  table?: string;
  /** how many nearest rows verifyRemoved inspects for the removed id; default 10 */
  topK?: number;
}

/**
 * Write-through to a pgvector table: the fact's text, its embedding, and its custody metadata as one row, keyed by
 * the fact id, in the Postgres a team already runs. Removal deletes the row, and verification embeds the text again
 * and checks the removed id is not among the nearest rows, which is what a retrieval query would return.
 */
export function pgvectorStore(client: PgLike, opts: PgvectorOptions): Store {
  const table = opts.table ?? "agent_memories";
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/.test(table)) throw new Error(`pgvector: table must be a plain identifier, optionally schema-qualified; got "${table}"`);
  if (!(Number.isInteger(opts.dimensions) && opts.dimensions > 0)) throw new Error("pgvector: dimensions must be a positive integer");
  let ready: Promise<void> | null = null;
  const init = () =>
    (ready ??= (async () => {
      await client.query("CREATE EXTENSION IF NOT EXISTS vector");
      await client.query(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, text TEXT NOT NULL, embedding vector(${opts.dimensions}) NOT NULL, metadata JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    })());
  const literal = (v: number[]) => {
    if (v.length !== opts.dimensions) throw new Error(`pgvector: embedding has ${v.length} dimensions, the table has ${opts.dimensions}`);
    return `[${v.join(",")}]`;
  };
  return {
    name: "pgvector",
    async put(fact) {
      await init();
      const text = factText(fact);
      await client.query(`INSERT INTO ${table} (id, text, embedding, metadata) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text, embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata`, [fact.factId, text, literal(await opts.embed(text)), JSON.stringify(factMetadata(fact))]);
      return fact.factId;
    },
    async remove(externalId) {
      await init();
      await client.query(`DELETE FROM ${table} WHERE id = $1`, [externalId]);
    },
    async verifyRemoved(externalId, fact) {
      await init();
      const rows = (await client.query(`SELECT id FROM ${table} ORDER BY embedding <=> $1 LIMIT $2`, [literal(await opts.embed(factText(fact))), opts.topK ?? 10])).rows as { id: string }[];
      return !rows.some((r) => r.id === externalId);
    },
  };
}


// ---- Letta ----
/** The subset of @letta-ai/letta-client's Letta this adapter uses: an agent's archival memory. */
export interface LettaLike {
  agents: {
    passages: {
      create(agentId: string, body: { text: string; tags?: string[] | null }): Promise<{ id: string }[]>;
      delete(memoryId: string, params: { agent_id: string }): Promise<unknown>;
      search?(agentId: string, query: { query: string; tags?: string[] | null; tag_match_mode?: "any" | "all" }): Promise<{ results: { id: string; content: string }[] }>;
    };
  };
}

export interface LettaOptions {
  /** the agent whose archival memory receives the fact */
  agentId: string;
  /** tags attached to every passage, beside the custody tags; default none */
  tags?: string[];
}

/**
 * Letta keeps archival memory as passages with text and tags, no free metadata. Custody travels as tags
 * (`agent-custody`, `fact:<id>`, `space:<name>`, `receipt:<id>`) so a passage always leads back to its fact.
 */
export function lettaStore(client: LettaLike, opts: LettaOptions): Store {
  const tagsFor = (f: Fact) => ["agent-custody", `fact:${f.factId}`, `space:${f.space}`, ...(f.source.receiptId ? [`receipt:${f.source.receiptId}`] : []), ...(opts.tags ?? [])];
  return {
    name: "letta",
    async put(fact) {
      const passages = await client.agents.passages.create(opts.agentId, { text: factText(fact), tags: tagsFor(fact) });
      const id = passages.find((p) => typeof p.id === "string")?.id;
      if (!id) throw new Error("letta returned no passage id");
      return id;
    },
    async remove(externalId) {
      await client.agents.passages.delete(externalId, { agent_id: opts.agentId });
    },
    ...(client.agents.passages.search
      ? {
          async verifyRemoved(externalId, fact) {
            const { results } = await client.agents.passages.search!(opts.agentId, { query: factText(fact), tags: [`fact:${fact.factId}`], tag_match_mode: "any" });
            return !results.some((r) => r.id === externalId || r.content === factText(fact));
          },
        }
      : {}),
  };
}

// ---- LangGraph store (LangMem) ----
/**
 * The subset of LangGraph's BaseStore this adapter uses. LangMem's memories live in this store, so custody over a
 * LangMem deployment is custody over its store: one item per fact, keyed by the fact id, in the namespace given.
 */
export interface LangGraphStoreLike {
  put(namespace: string[], key: string, value: Record<string, unknown>): Promise<void>;
  get(namespace: string[], key: string): Promise<{ key: string; value: Record<string, unknown> } | null>;
  delete(namespace: string[], key: string): Promise<void>;
  search?(namespacePrefix: string[], options?: { filter?: Record<string, unknown>; limit?: number; query?: string }): Promise<{ key: string; namespace: string[]; value: Record<string, unknown> }[]>;
}

export interface LangGraphStoreOptions {
  /** the namespace the memories live under, e.g. ["memories", userId] */
  namespace: string[];
}

export function langgraphStore(store: LangGraphStoreLike, opts: LangGraphStoreOptions): Store {
  return {
    name: "langgraph",
    async put(fact) {
      await store.put(opts.namespace, fact.factId, { content: factText(fact), subject: fact.subject, predicate: fact.predicate, value: fact.value, ...factMetadata(fact) });
      return fact.factId;
    },
    async remove(externalId) {
      await store.delete(opts.namespace, externalId);
    },
    async verifyRemoved(externalId, fact) {
      if ((await store.get(opts.namespace, externalId)) !== null) return false;
      if (!store.search) return true;
      const hits = await store.search(opts.namespace, { filter: { factId: fact.factId }, limit: 10 });
      return !hits.some((h) => h.key === externalId);
    },
  };
}

// ---- Cognee ----
export interface CogneeOptions {
  /** the Cognee server, e.g. http://localhost:8000 */
  url: string;
  /** the dataset the facts go into, by id */
  datasetId: string;
  /** environment variable holding an API key (sent as X-Api-Key) */
  apiKeyEnv?: string;
  /** environment variable holding a bearer token (sent as Authorization: Bearer) */
  tokenEnv?: string;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
}

/**
 * Cognee has no JavaScript client; this adapter speaks its REST API directly, built against the add and datasets
 * routers of cognee 0.3: `POST /api/v1/add` (multipart, `raw_data` and `external_metadata`), `GET
 * /api/v1/datasets/{id}/data`, `DELETE /api/v1/datasets/{id}/data/{dataId}`. The add call returns a pipeline run,
 * not the data id, so the id is found by listing the dataset and matching the fact id written into the item's
 * external metadata. Tested against a stand-in of those three routes, not against a running Cognee.
 */
export function cogneeStore(opts: CogneeOptions): Store {
  const f = opts.fetch ?? fetch;
  const env = opts.env ?? process.env;
  const headers: Record<string, string> = {};
  if (opts.apiKeyEnv) {
    const v = env[opts.apiKeyEnv];
    if (!v) throw new Error(`cognee: environment variable ${opts.apiKeyEnv} is not set`);
    headers["x-api-key"] = v;
  }
  if (opts.tokenEnv) {
    const v = env[opts.tokenEnv];
    if (!v) throw new Error(`cognee: environment variable ${opts.tokenEnv} is not set`);
    headers.authorization = `Bearer ${v}`;
  }
  const base = opts.url.endsWith("/") ? opts.url : `${opts.url}/`;
  const call = async (method: string, path: string, body?: BodyInit): Promise<unknown> => {
    const res = await f(new URL(path, base), { method, headers, ...(body ? { body } : {}), signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`cognee ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
  interface Item { id: string; external_metadata?: unknown; name?: string }
  const list = async (): Promise<Item[]> => (await call("GET", `api/v1/datasets/${opts.datasetId}/data`)) as Item[];
  const metadataOf = (item: Item): Record<string, unknown> => {
    const m = item.external_metadata;
    if (typeof m === "string") {
      try {
        return JSON.parse(m) as Record<string, unknown>;
      } catch {
        return {};
      }
    }
    return (m ?? {}) as Record<string, unknown>;
  };
  return {
    name: "cognee",
    async put(fact) {
      const form = new FormData();
      form.append("raw_data", factText(fact));
      form.append("datasetId", opts.datasetId);
      form.append("external_metadata", JSON.stringify([factMetadata(fact)]));
      form.append("labels", JSON.stringify(["agent-custody", `fact:${fact.factId}`]));
      await call("POST", "api/v1/add", form);
      const item = (await list()).reverse().find((i) => metadataOf(i).factId === fact.factId);
      if (!item) throw new Error(`cognee accepted the add but the dataset lists no item carrying fact ${fact.factId}`);
      return item.id;
    },
    async remove(externalId) {
      await call("DELETE", `api/v1/datasets/${opts.datasetId}/data/${externalId}`);
    },
    async verifyRemoved(externalId, fact) {
      return !(await list()).some((i) => i.id === externalId || metadataOf(i).factId === fact.factId);
    },
  };
}

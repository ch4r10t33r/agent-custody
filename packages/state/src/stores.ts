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


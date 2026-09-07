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

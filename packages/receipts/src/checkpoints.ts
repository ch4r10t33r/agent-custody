// Checkpoints: signed tree heads published on a schedule to a place the log's own API does not have to be up to
// serve. A verifier who kept a head can fetch a later checkpoint and the consistency proof between them, and
// learn that nothing was rewritten while nobody was watching. On disk they are plain files, one per tree size,
// meant to be served statically from a second host; in Postgres they are rows, so the API can list them too.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Envelope } from "./crypto.ts";
import type { PostgresLike } from "./log-store.ts";

export interface Checkpoint {
  tenant: string;
  logId: string | undefined;
  treeSize: number;
  rootHash: string;
  signedAt: string;
  envelope: Envelope;
}

export interface CheckpointStore {
  save(c: Checkpoint): Promise<void>;
  /** checkpoints of a tenant with treeSize > since, oldest first */
  list(tenant: string, since?: number): Promise<Checkpoint[]>;
  latest(tenant: string): Promise<Checkpoint | null>;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "_");

/** Files: <dir>/<tenant>/<treeSize>.json and <dir>/<tenant>/latest.json. Serve the directory read-only from the checkpoints host. */
export function dirCheckpoints(dir: string): CheckpointStore {
  const folder = (tenant: string) => join(dir, safe(tenant));
  const read = (tenant: string, name: string): Checkpoint | null => {
    try {
      return JSON.parse(readFileSync(join(folder(tenant), name), "utf8")) as Checkpoint;
    } catch {
      return null;
    }
  };
  return {
    async save(c) {
      mkdirSync(folder(c.tenant), { recursive: true });
      const text = JSON.stringify(c, null, 2);
      writeFileSync(join(folder(c.tenant), `${c.treeSize}.json`), text);
      writeFileSync(join(folder(c.tenant), "latest.json"), text);
    },
    async list(tenant, since = -1) {
      let names: string[];
      try {
        names = readdirSync(folder(tenant));
      } catch {
        return [];
      }
      return names
        .filter((n) => /^\d+\.json$/.test(n))
        .map((n) => Number(n.slice(0, -5)))
        .filter((n) => n > since)
        .sort((a, b) => a - b)
        .map((n) => read(tenant, `${n}.json`))
        .filter((c): c is Checkpoint => c !== null);
    },
    async latest(tenant) {
      return read(tenant, "latest.json");
    },
  };
}

/** Rows in <prefix>heads, one per tenant and tree size. */
export function postgresCheckpoints(client: PostgresLike, prefix = "log_"): CheckpointStore {
  if (!/^[a-z_][a-z0-9_]*$/.test(prefix)) throw new Error(`prefix must be a plain lowercase identifier; got "${prefix}"`);
  const table = `${prefix}heads`;
  let ready: Promise<void> | null = null;
  const init = () => (ready ??= client.query(`CREATE TABLE IF NOT EXISTS ${table} (tenant_id TEXT NOT NULL, tree_size BIGINT NOT NULL, log_id TEXT, root_hash TEXT NOT NULL, signed_at TIMESTAMPTZ NOT NULL, envelope TEXT NOT NULL, PRIMARY KEY (tenant_id, tree_size))`).then(() => {}));
  const row = (r: Record<string, unknown>): Checkpoint => ({ tenant: String(r.tenant_id), logId: r.log_id ? String(r.log_id) : undefined, treeSize: Number(r.tree_size), rootHash: String(r.root_hash), signedAt: new Date(r.signed_at as string).toISOString(), envelope: JSON.parse(String(r.envelope)) as Envelope });
  return {
    async save(c) {
      await init();
      await client.query(`INSERT INTO ${table} (tenant_id, tree_size, log_id, root_hash, signed_at, envelope) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (tenant_id, tree_size) DO NOTHING`, [c.tenant, c.treeSize, c.logId ?? null, c.rootHash, c.signedAt, JSON.stringify(c.envelope)]);
    },
    async list(tenant, since = -1) {
      await init();
      return ((await client.query(`SELECT tenant_id, tree_size, log_id, root_hash, signed_at, envelope FROM ${table} WHERE tenant_id = $1 AND tree_size > $2 ORDER BY tree_size`, [tenant, since])).rows as Record<string, unknown>[]).map(row);
    },
    async latest(tenant) {
      await init();
      const rows = (await client.query(`SELECT tenant_id, tree_size, log_id, root_hash, signed_at, envelope FROM ${table} WHERE tenant_id = $1 ORDER BY tree_size DESC LIMIT 1`, [tenant])).rows as Record<string, unknown>[];
      return rows[0] ? row(rows[0]) : null;
    },
  };
}

/**
 * Writes every checkpoint to each store: the directory the checkpoints host serves and the database the API lists
 * from. `latest` is the store that is furthest behind, so a store that missed a write (a directory that was not yet
 * writable, say) is caught up on the next publication; saves are idempotent in every store.
 */
export function bothCheckpoints(...stores: CheckpointStore[]): CheckpointStore {
  return {
    async save(c) {
      for (const s of stores) await s.save(c);
    },
    list: (t, since) => stores[0]!.list(t, since),
    async latest(t) {
      let behind: Checkpoint | undefined;
      for (const s of stores) {
        const l = await s.latest(t);
        if (l === null) return null;
        if (behind === undefined || l.treeSize < behind.treeSize) behind = l;
      }
      return behind ?? null;
    },
  };
}

// Where a log server keeps its logs. The file backend is the reference server as it was: one JSONL file per log,
// read into memory. The Postgres backend is a log run for other people: leaves in one table keyed by tenant, one
// writer per tenant enforced by an advisory lock so a second instance is safe, tenants and their tokens in tables of
// their own, and rate limits per token. The subtree cache stays in memory on every instance and resyncs from the
// table whenever the table has moved on without it.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { leafHash, MerkleLog, SubtreeCache, type InclusionProof } from "./log.ts";

export interface AppendResult extends InclusionProof {
  rootHash: string;
}

/** One log, as the server sees it: everything a Merkle log answers, asynchronously, so a database can stand behind it. */
export interface LogBackend {
  size(): Promise<number>;
  append(leaf: string): Promise<AppendResult>;
  appendHash(leafHashHex: string): Promise<AppendResult>;
  root(size?: number): Promise<string>;
  consistencyProof(oldSize: number, newSize?: number): Promise<string[]>;
  /** leaf hashes from (inclusive) to (exclusive), hex */
  leafHashes(from: number, to: number): Promise<string[]>;
}

/** The JSONL file log behind the asynchronous interface. */
export function fileBackend(file: string): LogBackend {
  const log = new MerkleLog(file);
  return {
    async size() {
      return log.size;
    },
    async append(leaf) {
      return log.append(leaf);
    },
    async appendHash(hex) {
      return log.appendHash(hex);
    },
    async root(size) {
      return log.root(size);
    },
    async leafHashes(from, to) {
      return log.leafHashes(from, to);
    },
    async consistencyProof(oldSize, newSize) {
      return log.consistencyProof(oldSize, newSize);
    },
  };
}

/**
 * What the Postgres backend needs from a client: the query method of a `pg` Pool and of PGlite, and, for a pool,
 * `connect` so a transaction runs on one connection. A store never closes a client it was given.
 */
export interface PostgresLike {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  connect?(): Promise<{ query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>; release(): void }>;
}

const ident = (s: string, what: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`${what} must be a plain lowercase identifier; got "${s}"`);
  return s;
};

export interface PostgresLogOptions {
  /** table name prefix; default "log_", giving log_leaves, log_tenants, log_tokens */
  prefix?: string;
}

/**
 * A client without `connect` is one connection (PGlite, a single pg Client), so its transactions must not interleave:
 * they are queued per client. A pool hands out a connection per transaction and the advisory lock does the rest.
 */
const queues = new WeakMap<PostgresLike, Promise<unknown>>();
function queued<T>(client: PostgresLike, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(client) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(client, next.catch(() => {}));
  return next;
}

/** Runs `fn` inside one transaction on one connection, whichever kind of client this is. */
async function transaction<T>(client: PostgresLike, fn: (q: PostgresLike["query"]) => Promise<T>): Promise<T> {
  if (!client.connect) return queued(client, () => singleConnectionTransaction(client, fn));
  {
    const c = await client.connect();
    try {
      await c.query("BEGIN");
      const out = await fn((t, v) => c.query(t, v));
      await c.query("COMMIT");
      return out;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }
}

async function singleConnectionTransaction<T>(client: PostgresLike, fn: (q: PostgresLike["query"]) => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    const out = await fn((t, v) => client.query(t, v));
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

/** One tenant's log in Postgres. Leaves are hashes only; the table never holds a receipt. */
export class PostgresLog implements LogBackend {
  readonly tenant: string;
  private readonly client: PostgresLike;
  private readonly leaves: string;
  private hashes: Buffer[] = [];
  private cache = new SubtreeCache(this.hashes);
  private ready: Promise<void> | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(client: PostgresLike, tenant: string, opts: PostgresLogOptions = {}) {
    this.client = client;
    this.tenant = tenant;
    this.leaves = `${ident(opts.prefix ?? "log_", "prefix")}leaves`;
  }

  static async ensureSchema(client: PostgresLike, prefix = "log_"): Promise<void> {
    const p = ident(prefix, "prefix");
    await client.query(`CREATE TABLE IF NOT EXISTS ${p}leaves (tenant_id TEXT NOT NULL, seq BIGINT NOT NULL, leaf_hash BYTEA NOT NULL, appended_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, seq))`);
  }

  private init(): Promise<void> {
    if (!this.ready) this.ready = PostgresLog.ensureSchema(this.client, this.leaves.slice(0, -"leaves".length)).then(() => this.reload(this.client.query.bind(this.client)));
    return this.ready;
  }

  /** Replaces the in-memory tree with what the table holds. Called when the table has moved on without this instance. */
  private async reload(q: PostgresLike["query"]): Promise<void> {
    const rows = (await q(`SELECT leaf_hash FROM ${this.leaves} WHERE tenant_id = $1 ORDER BY seq`, [this.tenant])).rows as { leaf_hash: Uint8Array | Buffer | string }[];
    this.hashes = rows.map((r) => (typeof r.leaf_hash === "string" ? Buffer.from(r.leaf_hash.replace(/^\\x/, ""), "hex") : Buffer.from(r.leaf_hash)));
    this.cache = new SubtreeCache(this.hashes);
  }

  private async count(q: PostgresLike["query"]): Promise<number> {
    return Number(((await q(`SELECT COALESCE(MAX(seq) + 1, 0) AS n FROM ${this.leaves} WHERE tenant_id = $1`, [this.tenant])).rows[0] as { n: string | number }).n);
  }

  private async sync(): Promise<void> {
    await this.init();
    const n = await this.count(this.client.query.bind(this.client));
    if (n !== this.hashes.length) await this.reload(this.client.query.bind(this.client));
  }

  async size(): Promise<number> {
    await this.sync();
    return this.hashes.length;
  }

  private commit(hash: Buffer): Promise<AppendResult> {
    const run = async (): Promise<AppendResult> => {
      await this.init();
      // One writer per tenant: the advisory lock serialises appends across instances, and the count check inside the
      // lock catches a tree that another instance has extended, so the in-memory cache is rebuilt before this leaf.
      await transaction(this.client, async (q) => {
        await q("SELECT pg_advisory_xact_lock(hashtext($1))", [this.tenant]);
        const n = await this.count(q);
        if (n !== this.hashes.length) await this.reload(q);
        await q(`INSERT INTO ${this.leaves} (tenant_id, seq, leaf_hash) VALUES ($1, $2, $3)`, [this.tenant, this.hashes.length, hash]);
      });
      this.hashes.push(hash);
      const treeSize = this.hashes.length;
      return { leafIndex: treeSize - 1, treeSize, hashes: this.cache.path(treeSize - 1, 0, treeSize).map((b) => b.toString("hex")), rootHash: this.cache.mth(0, treeSize).toString("hex") };
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }

  async append(leaf: string): Promise<AppendResult> {
    return this.commit(leafHash(leaf));
  }

  async appendHash(leafHashHex: string): Promise<AppendResult> {
    if (!/^[0-9a-f]{64}$/.test(leafHashHex)) throw new Error("leafHash must be 64 lowercase hex characters");
    return this.commit(Buffer.from(leafHashHex, "hex"));
  }

  async leafHashes(from: number, to: number): Promise<string[]> {
    const n = await this.size();
    return this.hashes.slice(Math.max(0, from), Math.min(to, n)).map((h) => h.toString("hex"));
  }

  async root(size?: number): Promise<string> {
    await this.sync();
    const n = size ?? this.hashes.length;
    if (n < 0 || n > this.hashes.length) throw new Error("size out of range");
    return this.cache.mth(0, n).toString("hex");
  }

  async consistencyProof(oldSize: number, newSize?: number): Promise<string[]> {
    await this.sync();
    const n = newSize ?? this.hashes.length;
    if (oldSize < 0 || oldSize > n || n > this.hashes.length) throw new Error("sizes out of range");
    if (oldSize === 0 || oldSize === n) return [];
    return this.cache.subproof(oldSize, 0, n, true).map((b) => b.toString("hex"));
  }
}

export interface Tenant {
  id: string;
  logId: string;
  createdAt: string;
  disabledAt: string | null;
}

export interface TokenRecord {
  tenantId: string;
  label: string;
  /** hex sha256 of the token; the token itself is shown once, at creation */
  tokenHash: string;
  createdAt: string;
  revokedAt: string | null;
}

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

/** Tenants and their tokens, in Postgres. Tokens are stored hashed; a lookup hashes what the caller presented. */
export class PostgresTenancy {
  private readonly client: PostgresLike;
  private readonly prefix: string;
  private readonly logs = new Map<string, PostgresLog>();
  private readonly tenantCache = new Map<string, { at: number; tenant: Tenant | null }>();
  private readonly tokenCache = new Map<string, number>();
  private ready: Promise<void> | null = null;

  constructor(client: PostgresLike, opts: PostgresLogOptions = {}) {
    this.client = client;
    this.prefix = ident(opts.prefix ?? "log_", "prefix");
  }

  private init(): Promise<void> {
    if (!this.ready) {
      const p = this.prefix;
      this.ready = (async () => {
        await PostgresLog.ensureSchema(this.client, p);
        await this.client.query(`CREATE TABLE IF NOT EXISTS ${p}tenants (id TEXT PRIMARY KEY, log_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), disabled_at TIMESTAMPTZ)`);
        await this.client.query(`CREATE TABLE IF NOT EXISTS ${p}tokens (token_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES ${p}tenants(id), label TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), revoked_at TIMESTAMPTZ)`);
      })();
    }
    return this.ready;
  }

  private row(r: Record<string, unknown>): Tenant {
    return { id: String(r.id), logId: String(r.log_id), createdAt: new Date(r.created_at as string).toISOString(), disabledAt: r.disabled_at ? new Date(r.disabled_at as string).toISOString() : null };
  }

  /** The tenant, or null. Answers from a ten-second cache, so a disabled tenant is refused within that. */
  async tenant(id: string): Promise<Tenant | null> {
    await this.init();
    const hit = this.tenantCache.get(id);
    if (hit && Date.now() - hit.at < 10_000) return hit.tenant;
    const rows = (await this.client.query(`SELECT id, log_id, created_at, disabled_at FROM ${this.prefix}tenants WHERE id = $1`, [id])).rows as Record<string, unknown>[];
    const tenant = rows[0] ? this.row(rows[0]) : null;
    this.tenantCache.set(id, { at: Date.now(), tenant });
    return tenant;
  }

  /** Whether the presented token is a live token of this tenant. Positive answers are cached for thirty seconds. */
  async authorize(tenantId: string, token: string | null): Promise<boolean> {
    if (!token) return false;
    await this.init();
    const hash = sha256hex(token);
    const key = `${tenantId}:${hash}`;
    const at = this.tokenCache.get(key);
    if (at && Date.now() - at < 30_000) return true;
    const rows = (await this.client.query(`SELECT 1 FROM ${this.prefix}tokens WHERE token_hash = $1 AND tenant_id = $2 AND revoked_at IS NULL`, [hash, tenantId])).rows;
    if (rows.length === 0) return false;
    this.tokenCache.set(key, Date.now());
    return true;
  }

  /** The tenant's log, one instance per tenant per process. */
  async log(tenantId: string): Promise<PostgresLog> {
    let l = this.logs.get(tenantId);
    if (!l) {
      l = new PostgresLog(this.client, tenantId, { prefix: this.prefix });
      this.logs.set(tenantId, l);
    }
    return l;
  }

  async addTenant(id: string, logId = id): Promise<Tenant> {
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new Error(`tenant id must be a plain identifier; got "${id}"`);
    await this.init();
    const rows = (await this.client.query(`INSERT INTO ${this.prefix}tenants (id, log_id) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET log_id = EXCLUDED.log_id RETURNING id, log_id, created_at, disabled_at`, [id, logId])).rows as Record<string, unknown>[];
    this.tenantCache.delete(id);
    return this.row(rows[0]!);
  }

  async disableTenant(id: string): Promise<void> {
    await this.init();
    await this.client.query(`UPDATE ${this.prefix}tenants SET disabled_at = now() WHERE id = $1 AND disabled_at IS NULL`, [id]);
    this.tenantCache.delete(id);
  }

  async listTenants(): Promise<Tenant[]> {
    await this.init();
    return ((await this.client.query(`SELECT id, log_id, created_at, disabled_at FROM ${this.prefix}tenants ORDER BY created_at`)).rows as Record<string, unknown>[]).map((r) => this.row(r));
  }

  /** Mints a token for a tenant. The token is returned once and stored only as its hash. */
  async addToken(tenantId: string, label: string): Promise<{ token: string; tokenHash: string }> {
    await this.init();
    if (!(await this.tenant(tenantId))) throw new Error(`unknown tenant ${tenantId}`);
    const token = randomBytes(32).toString("hex");
    const tokenHash = sha256hex(token);
    await this.client.query(`INSERT INTO ${this.prefix}tokens (token_hash, tenant_id, label) VALUES ($1, $2, $3)`, [tokenHash, tenantId, label]);
    return { token, tokenHash };
  }

  /** Revokes the tokens of a tenant whose hash starts with the prefix; returns how many. */
  async revokeToken(tenantId: string, hashPrefix: string): Promise<number> {
    await this.init();
    if (hashPrefix.length < 8) throw new Error("give at least eight characters of the token hash");
    const rows = (await this.client.query(`UPDATE ${this.prefix}tokens SET revoked_at = now() WHERE tenant_id = $1 AND token_hash LIKE $2 AND revoked_at IS NULL RETURNING token_hash`, [tenantId, `${hashPrefix}%`])).rows as { token_hash: string }[];
    for (const r of rows) this.tokenCache.delete(`${tenantId}:${r.token_hash}`);
    return rows.length;
  }

  /**
   * Appends per tenant for one month, YYYY-MM in UTC, plus each tenant's total leaves and live tokens: the numbers
   * any pricing rests on. One query on the leaves table, grouped; tenants with no appends that month show zero.
   */
  async usage(month: string): Promise<{ month: string; tenants: { id: string; logId: string; appends: number; totalLeaves: number; liveTokens: number; disabled: boolean }[] }> {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("month must be YYYY-MM");
    await this.init();
    const start = `${month}-01T00:00:00Z`;
    const [y, m] = month.split("-").map(Number) as [number, number];
    const end = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01T00:00:00Z`;
    const p = this.prefix;
    const rows = (await this.client.query(
      `SELECT t.id, t.log_id, t.disabled_at,
              (SELECT COUNT(*) FROM ${p}leaves l WHERE l.tenant_id = t.id AND l.appended_at >= $1::timestamptz AND l.appended_at < $2::timestamptz) AS appends,
              (SELECT COUNT(*) FROM ${p}leaves l WHERE l.tenant_id = t.id) AS total,
              (SELECT COUNT(*) FROM ${p}tokens k WHERE k.tenant_id = t.id AND k.revoked_at IS NULL) AS live
       FROM ${p}tenants t ORDER BY t.created_at`,
      [start, end],
    )).rows as Record<string, unknown>[];
    return { month, tenants: rows.map((r) => ({ id: String(r.id), logId: String(r.log_id), appends: Number(r.appends), totalLeaves: Number(r.total), liveTokens: Number(r.live), disabled: !!r.disabled_at })) };
  }

  async listTokens(tenantId: string): Promise<TokenRecord[]> {
    await this.init();
    return ((await this.client.query(`SELECT tenant_id, label, token_hash, created_at, revoked_at FROM ${this.prefix}tokens WHERE tenant_id = $1 ORDER BY created_at`, [tenantId])).rows as Record<string, unknown>[]).map((r) => ({ tenantId: String(r.tenant_id), label: String(r.label), tokenHash: String(r.token_hash), createdAt: new Date(r.created_at as string).toISOString(), revokedAt: r.revoked_at ? new Date(r.revoked_at as string).toISOString() : null }));
  }
}

/**
 * Copies a JSONL log file into a backend as hashes: leaf strings are hashed, {pruned} and {hash} lines are taken as
 * they are. Skips the leaves the backend already has, so it can be re-run. Returns how many were added.
 */
export async function importLogFile(file: string, into: LogBackend): Promise<{ added: number; total: number }> {
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  const have = await into.size();
  let added = 0;
  for (let i = have; i < lines.length; i++) {
    const parsed = JSON.parse(lines[i]!) as string | { pruned?: string; hash?: string };
    await into.appendHash(typeof parsed === "string" ? leafHash(parsed).toString("hex") : (parsed.pruned ?? parsed.hash)!);
    added++;
  }
  return { added, total: lines.length };
}

export interface RateLimitOptions {
  /** sustained appends per second per key; default 50 */
  perSecond?: number;
  /** how many may arrive at once before the limit bites; default 100 */
  burst?: number;
}

/** A token bucket per key, in memory: enough to keep one tenant from crowding out the rest on one instance. */
export class RateLimiter {
  private readonly perSecond: number;
  private readonly burst: number;
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(opts: RateLimitOptions = {}) {
    this.perSecond = opts.perSecond ?? 50;
    this.burst = opts.burst ?? 100;
  }
  /** Takes one unit for the key; false when the key must wait. */
  take(key: string, now = Date.now()): boolean {
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: now };
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.perSecond);
    b.at = now;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) for (const [k, v] of this.buckets) if (now - v.at > 60_000) this.buckets.delete(k);
    return true;
  }
}

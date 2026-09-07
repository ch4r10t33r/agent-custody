// Where the ledger's events live. The ledger asks the store questions and never assumes it holds every event, so a
// store may be a file on this machine or a database shared by many servers.
//
// JSONL is the default and the auditable artefact: one event per line, readable by anyone, copied for an audit. It
// keeps the events in memory and answers from there. SQLite is for durability on one machine: transactional writes,
// write-ahead logging, an in-place forget that leaves no copy of the value behind, and every query answered by an
// index. Postgres is for a shared ledger: several memory servers on one table, the database your security team has
// already approved, the same queries pushed down as SQL.
//
// Every store answers the same four questions: everything (for export and audits), everything about the facts that
// match a filter (for "what is believed"), everything that touched one fact (for its history and its checks), and
// the spaces it holds (for retention). A store that cannot answer one of these from an index is the wrong store.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { AssertEvent, LedgerEvent } from "./ledger.ts";

/** Which facts a query is about. Every field narrows; an absent field means any. */
export interface EventQuery {
  /** only events the ledger had recorded by this instant, inclusive; the transaction-time cut of a bitemporal read */
  txAtMost?: string;
  /** only facts the ledger learned of strictly before this instant; the cut of a retention sweep */
  txBefore?: string;
  space?: string;
  subject?: string;
  predicate?: string;
}

export interface EventStore {
  readonly kind: string;
  /** a path or a connection description, for reports; never a secret */
  readonly location: string;
  /** every event, in order */
  events(): Promise<LedgerEvent[]>;
  count(): Promise<number>;
  /**
   * Every event about the facts that match the query, in order: their asserts, the asserts that supersede them, and
   * every retraction, confirmation, forget, hold and release citing them. What a bitemporal read needs, and no more.
   */
  eventsAbout(q: EventQuery): Promise<LedgerEvent[]>;
  /** every event that touched one fact, in order: its assert, the asserts that supersede it, everything citing its id */
  eventsFor(factId: string): Promise<LedgerEvent[]>;
  /** every space with at least one fact */
  spaces(): Promise<string[]>;
  append(event: LedgerEvent): Promise<void>;
  /** replaces one assert event in place, for forget: the value is gone from the store, not merely superseded */
  replaceAssert(event: AssertEvent): Promise<void>;
  /** after erasures: reclaims whatever the store may still hold of the erased values. A no-op where nothing lingers. */
  compact(): Promise<void>;
  close(): Promise<void>;
}

const factIdOf = (e: LedgerEvent): string => (e.kind === "assert" ? e.fact.factId : e.factId);

/** The reference semantics of eventsAbout, over an in-memory list. The SQL stores must answer identically; the ledger suite runs against all of them. */
export function selectAbout(events: LedgerEvent[], q: EventQuery): LedgerEvent[] {
  const ids = new Set<string>();
  for (const e of events) {
    if (e.kind !== "assert") continue;
    if (q.txAtMost !== undefined && e.txTime > q.txAtMost) continue;
    if (q.txBefore !== undefined && e.txTime >= q.txBefore) continue;
    if (q.space !== undefined && e.fact.space !== q.space) continue;
    if (q.subject !== undefined && e.fact.subject !== q.subject) continue;
    if (q.predicate !== undefined && e.fact.predicate !== q.predicate) continue;
    ids.add(e.fact.factId);
  }
  for (const e of events) if (e.kind === "assert" && e.supersedes && ids.has(e.supersedes)) ids.add(e.fact.factId);
  return events.filter((e) => ids.has(factIdOf(e)) && (q.txAtMost === undefined || e.txTime <= q.txAtMost));
}

/** The reference semantics of eventsFor. */
export function selectFor(events: LedgerEvent[], factId: string): LedgerEvent[] {
  return events.filter((e) => (e.kind === "assert" ? e.fact.factId === factId || e.supersedes === factId : e.factId === factId));
}

export class JsonlStore implements EventStore {
  readonly kind = "jsonl";
  readonly location: string;
  private cache: LedgerEvent[] | null = null;
  constructor(file: string) {
    this.location = file;
    if (!existsSync(file)) mkdirSync(dirname(file), { recursive: true });
  }
  private all(): LedgerEvent[] {
    if (this.cache) return this.cache;
    this.cache = existsSync(this.location) ? readFileSync(this.location, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as LedgerEvent) : [];
    return this.cache;
  }
  async events(): Promise<LedgerEvent[]> {
    return [...this.all()];
  }
  async count(): Promise<number> {
    return this.all().length;
  }
  async eventsAbout(q: EventQuery): Promise<LedgerEvent[]> {
    return selectAbout(this.all(), q);
  }
  async eventsFor(factId: string): Promise<LedgerEvent[]> {
    return selectFor(this.all(), factId);
  }
  async spaces(): Promise<string[]> {
    return [...new Set(this.all().filter((e): e is AssertEvent => e.kind === "assert").map((e) => e.fact.space))].sort();
  }
  async append(event: LedgerEvent): Promise<void> {
    const list = this.all();
    appendFileSync(this.location, JSON.stringify(event) + "\n");
    list.push(event);
  }
  async replaceAssert(event: AssertEvent): Promise<void> {
    const all = this.all().map((e) => (e.kind === "assert" && e.eventId === event.eventId ? event : e));
    const tmp = `${this.location}.tmp`;
    writeFileSync(tmp, all.map((e) => JSON.stringify(e)).join("\n") + "\n");
    renameSync(tmp, this.location);
    this.cache = all;
  }
  async compact(): Promise<void> {}
  async close(): Promise<void> {}
}

/** Minimal shape of node:sqlite this store uses, so the module is loaded only when a SQLite ledger is opened. */
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: unknown[]): unknown; all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown };
  close(): void;
}

/** The columns every SQL store keeps beside the event's JSON, so its queries are index lookups and never a scan of the JSON. */
function columns(event: LedgerEvent): { factId: string; space: string | null; subject: string | null; predicate: string | null; supersedes: string | null } {
  return event.kind === "assert"
    ? { factId: event.fact.factId, space: event.fact.space, subject: event.fact.subject, predicate: event.fact.predicate, supersedes: event.supersedes }
    : { factId: event.factId, space: null, subject: null, predicate: null, supersedes: null };
}

/**
 * The query behind eventsAbout, built with only the clauses the query has, so each store's planner uses the matching
 * index instead of a scan; `bind` turns a value into that store's placeholder.
 */
function aboutSql(q: EventQuery, table: string, bind: (value: string) => string): string {
  const conds = ["kind = 'assert'"];
  if (q.txAtMost !== undefined) conds.push(`tx_time <= ${bind(q.txAtMost)}`);
  if (q.txBefore !== undefined) conds.push(`tx_time < ${bind(q.txBefore)}`);
  if (q.space !== undefined) conds.push(`space = ${bind(q.space)}`);
  if (q.subject !== undefined) conds.push(`subject = ${bind(q.subject)}`);
  if (q.predicate !== undefined) conds.push(`predicate = ${bind(q.predicate)}`);
  const outer = q.txAtMost !== undefined ? ` AND tx_time <= ${bind(q.txAtMost)}` : "";
  return `WITH matched AS (SELECT fact_id FROM ${table} WHERE ${conds.join(" AND ")}),
    ids AS (SELECT fact_id FROM matched UNION SELECT fact_id FROM ${table} WHERE kind = 'assert' AND supersedes IN (SELECT fact_id FROM matched))
    SELECT json FROM ${table} WHERE fact_id IN (SELECT fact_id FROM ids)${outer} ORDER BY seq`;
}

/** Distinct spaces by walking the space index one key at a time, rather than reading every row; non-assert rows have no space. */
const spacesSql = (table: string) => `WITH RECURSIVE s(space) AS (SELECT MIN(space) FROM ${table} UNION ALL SELECT (SELECT MIN(space) FROM ${table} WHERE space > s.space) FROM s WHERE s.space IS NOT NULL) SELECT space FROM s WHERE space IS NOT NULL`;

const forSql = (table: string, ph: string) => `SELECT json FROM ${table} WHERE fact_id = ${ph} OR supersedes = ${ph} ORDER BY seq`;

/** One index per question the ledger asks: by fact, by subject (and predicate), by space (and time), by what a fact supersedes, by time. */
const INDEXES: [string, string][] = [
  ["fact", "(fact_id)"],
  ["subject", "(subject, predicate)"],
  ["space", "(space, tx_time)"],
  ["supersedes", "(supersedes)"],
  ["tx", "(tx_time)"],
];

export class SqliteStore implements EventStore {
  readonly kind = "sqlite";
  readonly location: string;
  private readonly db: SqliteDatabase;
  constructor(file: string) {
    this.location = file;
    mkdirSync(dirname(file), { recursive: true });
    // Loaded on demand so a JSONL ledger never touches the SQLite module, which warns on Node 22 that it is experimental.
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDatabase };
    this.db = new DatabaseSync(file);
    // secure_delete overwrites removed content with zeros, so a forgotten value does not linger in freed page space.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;");
    this.db.exec("CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, tx_time TEXT NOT NULL, fact_id TEXT NOT NULL, space TEXT, subject TEXT, predicate TEXT, supersedes TEXT, json TEXT NOT NULL)");
    // A ledger written before the query columns existed gets them filled from its JSON, once.
    const have = new Set((this.db.prepare("PRAGMA table_info(events)").all() as { name: string }[]).map((c) => c.name));
    if (!have.has("space")) {
      for (const c of ["space", "subject", "predicate", "supersedes"]) this.db.exec(`ALTER TABLE events ADD COLUMN ${c} TEXT`);
      this.db.exec("UPDATE events SET space = json_extract(json, '$.fact.space'), subject = json_extract(json, '$.fact.subject'), predicate = json_extract(json, '$.fact.predicate'), supersedes = json_extract(json, '$.supersedes') WHERE kind = 'assert'");
    }
    for (const [name, cols] of INDEXES) this.db.exec(`CREATE INDEX IF NOT EXISTS events_${name} ON events ${cols}`);
    // Without statistics the planner guesses which index to use and can pick a wide one; analyze once, then let
    // close() refresh the statistics when the table has grown enough to matter.
    const stats = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'").get() && this.db.prepare("SELECT 1 FROM sqlite_stat1 WHERE tbl = 'events' LIMIT 1").get();
    if (!stats) this.db.exec("ANALYZE");
  }
  private rows(sql: string, params: unknown[] = []): LedgerEvent[] {
    return (this.db.prepare(sql).all(...params) as { json: string }[]).map((r) => JSON.parse(r.json) as LedgerEvent);
  }
  async events(): Promise<LedgerEvent[]> {
    return this.rows("SELECT json FROM events ORDER BY seq");
  }
  async count(): Promise<number> {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
  }
  async eventsAbout(q: EventQuery): Promise<LedgerEvent[]> {
    const params: unknown[] = [];
    const sql = aboutSql(q, "events", (v) => {
      params.push(v);
      return "?";
    });
    return this.rows(sql, params);
  }
  async eventsFor(factId: string): Promise<LedgerEvent[]> {
    return this.rows(forSql("events", "?"), [factId, factId]);
  }
  async spaces(): Promise<string[]> {
    return (this.db.prepare(spacesSql("events")).all() as { space: string }[]).map((r) => r.space);
  }
  async append(event: LedgerEvent): Promise<void> {
    const c = columns(event);
    this.db.prepare("INSERT INTO events (event_id, kind, tx_time, fact_id, space, subject, predicate, supersedes, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(event.eventId, event.kind, event.txTime, c.factId, c.space, c.subject, c.predicate, c.supersedes, JSON.stringify(event));
  }
  async replaceAssert(event: AssertEvent): Promise<void> {
    this.db.prepare("UPDATE events SET json = ? WHERE event_id = ?").run(JSON.stringify(event), event.eventId);
  }
  async compact(): Promise<void> {
    // The old row image would otherwise linger in the write-ahead log; a truncating checkpoint removes it.
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  async close(): Promise<void> {
    this.db.exec("PRAGMA optimize");
    this.db.close();
  }
}

/**
 * What the Postgres store needs from a client: the query method of a `pg` Pool or Client, and of PGlite. Pass your
 * own pool, with whatever TLS, credentials, and sizing you already use; the store never closes a client it was given.
 */
export interface PostgresLike {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface PostgresOptions {
  /** the table, optionally schema-qualified; default "events". Created if missing. */
  table?: string;
  /**
   * Whether compact() runs VACUUM FULL on the table after erasures, so the old row image that MVCC keeps is not left
   * in the table file. Default true. It takes an exclusive lock for the rewrite, so a very large ledger may prefer
   * false and its own vacuum schedule; the forget certificate then rests on that schedule.
   */
  vacuum?: boolean;
  /** shown as the store's location in reports; default the table name */
  location?: string;
}

export class PostgresStore implements EventStore {
  readonly kind = "postgres";
  readonly location: string;
  private readonly client: PostgresLike;
  private readonly table: string;
  private readonly vacuum: boolean;
  private readonly owned: boolean;
  private ready: Promise<void> | null = null;
  constructor(client: PostgresLike, opts: PostgresOptions & { /** internal: the store created the client and closes it */ owned?: boolean } = {}) {
    const table = opts.table ?? "events";
    if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/.test(table)) throw new Error(`postgres: table name must be a plain identifier, optionally schema-qualified; got "${table}"`);
    this.client = client;
    this.table = table;
    this.vacuum = opts.vacuum ?? true;
    this.owned = opts.owned ?? false;
    this.location = opts.location ?? `postgres table ${table}`;
  }
  private init(): Promise<void> {
    if (!this.ready) {
      const t = this.table;
      const idx = t.replace(".", "_");
      this.ready = (async () => {
        await this.client.query(`CREATE TABLE IF NOT EXISTS ${t} (seq BIGSERIAL PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, tx_time TEXT NOT NULL, fact_id TEXT NOT NULL, space TEXT, subject TEXT, predicate TEXT, supersedes TEXT, json TEXT NOT NULL)`);
        for (const [name, cols] of INDEXES) await this.client.query(`CREATE INDEX IF NOT EXISTS ${idx}_${name} ON ${t} ${cols}`);
      })();
    }
    return this.ready;
  }
  private async rows(sql: string, values: unknown[] = []): Promise<LedgerEvent[]> {
    await this.init();
    return ((await this.client.query(sql, values)).rows as { json: string | LedgerEvent }[]).map((r) => (typeof r.json === "string" ? (JSON.parse(r.json) as LedgerEvent) : r.json));
  }
  async events(): Promise<LedgerEvent[]> {
    return this.rows(`SELECT json FROM ${this.table} ORDER BY seq`);
  }
  async count(): Promise<number> {
    await this.init();
    return Number(((await this.client.query(`SELECT COUNT(*) AS n FROM ${this.table}`)).rows[0] as { n: string | number }).n);
  }
  async eventsAbout(q: EventQuery): Promise<LedgerEvent[]> {
    const params: unknown[] = [];
    const sql = aboutSql(q, this.table, (v) => {
      params.push(v);
      return `$${params.length}`;
    });
    return this.rows(sql, params);
  }
  async eventsFor(factId: string): Promise<LedgerEvent[]> {
    return this.rows(forSql(this.table, "$1"), [factId]);
  }
  async spaces(): Promise<string[]> {
    await this.init();
    return ((await this.client.query(spacesSql(this.table))).rows as { space: string }[]).map((r) => r.space);
  }
  async append(event: LedgerEvent): Promise<void> {
    await this.init();
    const c = columns(event);
    await this.client.query(`INSERT INTO ${this.table} (event_id, kind, tx_time, fact_id, space, subject, predicate, supersedes, json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [event.eventId, event.kind, event.txTime, c.factId, c.space, c.subject, c.predicate, c.supersedes, JSON.stringify(event)]);
  }
  async replaceAssert(event: AssertEvent): Promise<void> {
    await this.init();
    await this.client.query(`UPDATE ${this.table} SET json = $1 WHERE event_id = $2`, [JSON.stringify(event), event.eventId]);
  }
  async compact(): Promise<void> {
    // An UPDATE leaves the old row image in the table until vacuum; VACUUM FULL rewrites the table without it.
    // The write-ahead log, replicas and backups keep their own copies for as long as their retention says.
    if (this.vacuum) await this.client.query(`VACUUM FULL ${this.table}`);
  }
  async close(): Promise<void> {
    if (this.owned) await (this.client as PostgresLike & { end(): Promise<void> }).end();
  }
}

/**
 * A store from a location: a postgres:// or postgresql:// URL (needs the `pg` package installed beside this one;
 * a `?table=` query parameter names the table, `?vacuum=false` skips VACUUM FULL after erasures), a path ending in
 * .sqlite or .db, or any other path as JSONL.
 */
export function openStore(location: string): EventStore {
  if (/^postgres(ql)?:\/\//i.test(location)) {
    let Pool: new (opts: { connectionString: string }) => PostgresLike & { end(): Promise<void> };
    try {
      ({ Pool } = createRequire(import.meta.url)("pg") as { Pool: typeof Pool });
    } catch {
      throw new Error("a postgres:// ledger needs the pg package: npm install pg");
    }
    const url = new URL(location);
    const table = url.searchParams.get("table") ?? undefined;
    const vacuum = url.searchParams.get("vacuum") !== "false";
    url.searchParams.delete("table");
    url.searchParams.delete("vacuum");
    const shown = `${url.protocol}//${url.username ? `${url.username}@` : ""}${url.host}${url.pathname}`;
    return new PostgresStore(new Pool({ connectionString: url.toString() }), { ...(table ? { table } : {}), vacuum, location: `${shown}${table ? ` table ${table}` : ""}`, owned: true });
  }
  return /\.(sqlite|db)$/i.test(location) ? new SqliteStore(location) : new JsonlStore(location);
}

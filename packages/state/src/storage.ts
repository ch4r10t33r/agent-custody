// Where the ledger's events live. The ledger keeps every event in memory for its queries; a store makes them durable.
// JSONL is the default and the auditable artefact: one event per line, readable by anyone, copied for an audit.
// SQLite is for durability and shared use: transactional writes, write-ahead logging, an in-place forget that leaves
// no copy of the value behind, and a file more than one process can open. Node ships the SQLite module; no native
// dependency.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { AssertEvent, LedgerEvent } from "./ledger.ts";

export interface EventStore {
  readonly kind: "jsonl" | "sqlite";
  readonly location: string;
  /** every event, in order */
  load(): LedgerEvent[];
  append(event: LedgerEvent): void;
  /** replaces one assert event in place, for forget: the value is gone from the store, not merely superseded */
  replaceAssert(event: AssertEvent): void;
  close(): void;
}

export class JsonlStore implements EventStore {
  readonly kind = "jsonl" as const;
  readonly location: string;
  constructor(file: string) {
    this.location = file;
    if (!existsSync(file)) mkdirSync(dirname(file), { recursive: true });
  }
  load(): LedgerEvent[] {
    if (!existsSync(this.location)) return [];
    return readFileSync(this.location, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as LedgerEvent);
  }
  append(event: LedgerEvent): void {
    appendFileSync(this.location, JSON.stringify(event) + "\n");
  }
  replaceAssert(event: AssertEvent): void {
    const all = this.load().map((e) => (e.kind === "assert" && e.eventId === event.eventId ? event : e));
    const tmp = `${this.location}.tmp`;
    writeFileSync(tmp, all.map((e) => JSON.stringify(e)).join("\n") + "\n");
    renameSync(tmp, this.location);
  }
  close(): void {}
}

/** Minimal shape of node:sqlite this store uses, so the module is loaded only when a SQLite ledger is opened. */
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
  close(): void;
}

export class SqliteStore implements EventStore {
  readonly kind = "sqlite" as const;
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
    this.db.exec("CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, tx_time TEXT NOT NULL, fact_id TEXT NOT NULL, json TEXT NOT NULL)");
    this.db.exec("CREATE INDEX IF NOT EXISTS events_fact ON events(fact_id); CREATE INDEX IF NOT EXISTS events_tx ON events(tx_time)");
  }
  load(): LedgerEvent[] {
    return (this.db.prepare("SELECT json FROM events ORDER BY seq").all() as { json: string }[]).map((r) => JSON.parse(r.json) as LedgerEvent);
  }
  append(event: LedgerEvent): void {
    const factId = event.kind === "assert" ? event.fact.factId : event.factId;
    this.db.prepare("INSERT INTO events (event_id, kind, tx_time, fact_id, json) VALUES (?, ?, ?, ?, ?)").run(event.eventId, event.kind, event.txTime, factId, JSON.stringify(event));
  }
  replaceAssert(event: AssertEvent): void {
    this.db.prepare("UPDATE events SET json = ? WHERE event_id = ?").run(JSON.stringify(event), event.eventId);
    // The old row image would otherwise linger in the write-ahead log; a truncating checkpoint removes it.
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  close(): void {
    this.db.close();
  }
}

/** JSONL unless the path ends in .sqlite or .db. */
export function openStore(location: string): EventStore {
  return /\.(sqlite|db)$/i.test(location) ? new SqliteStore(location) : new JsonlStore(location);
}

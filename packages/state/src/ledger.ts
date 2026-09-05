// The fact ledger: an append-only JSONL log of events about what an agent believes.
// Bitemporal. Valid time is when a fact was true in the world; transaction time is when the ledger learned of it.
// Nothing is ever edited in place. Correcting a belief is a new event, so "what did the agent believe at T" is always answerable.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/** Where a write came from. A receipt id means the write went through a receipts producer and can be verified there. */
export interface Source {
  receiptId: string | null;
}

export interface Fact {
  factId: string;
  subject: string;
  predicate: string;
  value: unknown;
  /** Which shared space the fact lives in: a person, a team, an org. ACLs attach here later. */
  space: string;
  /** Who wrote it: a user id, an agent id, a tool name. */
  actor: string;
  source: Source;
  /** ISO timestamps. validTo is null while the fact is believed to still hold. */
  validFrom: string;
  validTo: string | null;
  confidence: number | null;
}

/** An assert creates a fact version. If it supersedes an earlier fact, that fact's validity ends where this one begins. */
export interface AssertEvent {
  eventId: string;
  kind: "assert";
  txTime: string;
  fact: Fact;
  supersedes: string | null;
}

/** A retract says the fact should never have been believed. It is the undo. The record stays; queries before txTime still see it. */
export interface RetractEvent {
  eventId: string;
  kind: "retract";
  txTime: string;
  factId: string;
  actor: string;
  reason: string;
  source: Source;
}

export type LedgerEvent = AssertEvent | RetractEvent;

export interface AssertInput {
  subject: string;
  predicate: string;
  value: unknown;
  space: string;
  actor: string;
  source?: Source;
  validFrom?: string;
  confidence?: number;
  supersedes?: string;
}

export interface RetractInput {
  factId: string;
  actor: string;
  reason: string;
  source?: Source;
}

export interface AsOf {
  /** Facts whose validity interval contains this instant. Default: now. */
  validAt?: string;
  /** Only events the ledger had recorded by this instant. Default: now. "What did the agent believe on Tuesday" sets both. */
  txAt?: string;
  space?: string;
  subject?: string;
  predicate?: string;
}

export class Ledger {
  private readonly events: LedgerEvent[] = [];
  private readonly file: string;
  private readonly now: () => Date;

  constructor(file: string, opts: { now?: () => Date } = {}) {
    this.file = file;
    this.now = opts.now ?? (() => new Date());
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (line.trim()) this.events.push(JSON.parse(line));
      }
    } else {
      mkdirSync(dirname(file), { recursive: true });
    }
  }

  get size(): number {
    return this.events.length;
  }

  assert(input: AssertInput): AssertEvent {
    const txTime = this.now().toISOString();
    const validFrom = input.validFrom ?? txTime;
    if (input.supersedes !== undefined) {
      const prior = this.factById(input.supersedes);
      if (!prior) throw new Error(`cannot supersede unknown fact ${input.supersedes}`);
      if (prior.fact.validTo !== null) throw new Error(`fact ${input.supersedes} is already superseded`);
      if (this.retractedAt(input.supersedes)) throw new Error(`fact ${input.supersedes} is retracted`);
      if (validFrom < prior.fact.validFrom) throw new Error(`replacement cannot start before the fact it supersedes`);
    }
    const event: AssertEvent = {
      eventId: randomUUID(),
      kind: "assert",
      txTime,
      fact: {
        factId: randomUUID(),
        subject: input.subject,
        predicate: input.predicate,
        value: input.value,
        space: input.space,
        actor: input.actor,
        source: input.source ?? { receiptId: null },
        validFrom,
        validTo: null,
        confidence: input.confidence ?? null,
      },
      supersedes: input.supersedes ?? null,
    };
    this.append(event);
    return event;
  }

  retract(input: RetractInput): RetractEvent {
    if (!this.factById(input.factId)) throw new Error(`cannot retract unknown fact ${input.factId}`);
    if (this.retractedAt(input.factId)) throw new Error(`fact ${input.factId} is already retracted`);
    const event: RetractEvent = {
      eventId: randomUUID(),
      kind: "retract",
      txTime: this.now().toISOString(),
      factId: input.factId,
      actor: input.actor,
      reason: input.reason,
      source: input.source ?? { receiptId: null },
    };
    this.append(event);
    return event;
  }

  /** The facts believed at a moment. Valid time answers "was it true then"; transaction time answers "did the ledger know it then". */
  asOf(q: AsOf = {}): Fact[] {
    const validAt = q.validAt ?? this.now().toISOString();
    const txAt = q.txAt ?? this.now().toISOString();
    const known = this.events.filter((e) => e.txTime <= txAt);
    const retracted = new Set(known.filter((e): e is RetractEvent => e.kind === "retract").map((e) => e.factId));
    const facts = new Map<string, Fact>();
    for (const e of known) {
      if (e.kind !== "assert") continue;
      facts.set(e.fact.factId, { ...e.fact });
      if (e.supersedes && facts.has(e.supersedes) && !retracted.has(e.fact.factId)) {
        facts.get(e.supersedes)!.validTo = e.fact.validFrom;
      }
    }
    return [...facts.values()].filter(
      (f) =>
        !retracted.has(f.factId) &&
        f.validFrom <= validAt &&
        (f.validTo === null || validAt < f.validTo) &&
        (q.space === undefined || f.space === q.space) &&
        (q.subject === undefined || f.subject === q.subject) &&
        (q.predicate === undefined || f.predicate === q.predicate),
    );
  }

  /** Every event that touched a fact, oldest first: its assert, the assert that superseded it, its retraction. */
  history(factId: string): LedgerEvent[] {
    return this.events.filter((e) => (e.kind === "assert" ? e.fact.factId === factId || e.supersedes === factId : e.factId === factId));
  }

  private factById(factId: string): AssertEvent | undefined {
    let found: AssertEvent | undefined;
    for (const e of this.events) {
      if (e.kind === "assert" && e.fact.factId === factId) found = { ...e, fact: { ...e.fact } };
      else if (e.kind === "assert" && e.supersedes === factId && found && !this.retractedAt(e.fact.factId)) found.fact.validTo = e.fact.validFrom;
    }
    return found;
  }

  private retractedAt(factId: string): boolean {
    return this.events.some((e) => e.kind === "retract" && e.factId === factId);
  }

  private append(event: LedgerEvent): void {
    appendFileSync(this.file, JSON.stringify(event) + "\n");
    this.events.push(event);
  }
}

// The memory-mutation eval harness. It scores a memory system on what goes wrong after writes, not on recall:
// stale facts still served after a correction was known, contradictions believed at once, and the blast radius of a
// bad write. It drives any system behind the same small interface, so this ledger and a store put under it are
// scored the same way, and a naive overwrite store scores badly for the right reasons.
import type { Fact } from "./ledger.ts";

/** What the harness needs from a memory system. Reads return whatever the system would give an agent right now. */
export interface MemoryUnderTest {
  write(input: { subject: string; predicate: string; value: unknown; space: string; actor: string; supersedes?: string }): Promise<{ id: string }> | { id: string };
  read(query: { subject: string; predicate?: string; space?: string }): Promise<Pick<Fact, "subject" | "predicate" | "value">[]> | Pick<Fact, "subject" | "predicate" | "value">[];
  retract(input: { id: string; actor: string; reason: string }): Promise<void> | void;
}

export type Op =
  | { op: "write"; key: string; subject: string; predicate: string; value: unknown; space?: string; actor?: string; supersedes?: string; /** the harness marks this write as wrong; later reads that return its value count against the system */ bad?: boolean }
  | { op: "read"; subject: string; predicate?: string; space?: string; /** the single value a correct system returns, or null for nothing */ expect: unknown | null }
  | { op: "retract"; key: string; actor?: string; reason?: string };

export interface Scenario {
  name: string;
  ops: Op[];
}

export interface ScenarioScore {
  name: string;
  reads: number;
  /** reads that returned a value the scenario says should no longer be believed */
  staleReads: number;
  /** reads that returned more than one value for one subject and predicate */
  contradictions: number;
  /** reads that returned the value of a write marked bad, before or after its retraction */
  blastRadius: number;
  /** reads whose result matched exactly what the scenario expected */
  correctReads: number;
  failures: string[];
}

export interface Report {
  scenarios: ScenarioScore[];
  totals: Omit<ScenarioScore, "name" | "failures">;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function runScenario(system: MemoryUnderTest, scenario: Scenario): Promise<ScenarioScore> {
  const ids = new Map<string, string>();
  const badValues: unknown[] = [];
  const score: ScenarioScore = { name: scenario.name, reads: 0, staleReads: 0, contradictions: 0, blastRadius: 0, correctReads: 0, failures: [] };
  for (const [i, op] of scenario.ops.entries()) {
    try {
      if (op.op === "write") {
        const supersedes = op.supersedes ? ids.get(op.supersedes) : undefined;
        if (op.supersedes && !supersedes) throw new Error(`write ${op.key} supersedes unknown key ${op.supersedes}`);
        const { id } = await system.write({ subject: op.subject, predicate: op.predicate, value: op.value, space: op.space ?? "org", actor: op.actor ?? "agent", ...(supersedes ? { supersedes } : {}) });
        ids.set(op.key, id);
        if (op.bad) badValues.push(op.value);
      } else if (op.op === "retract") {
        const id = ids.get(op.key);
        if (!id) throw new Error(`retract of unknown key ${op.key}`);
        await system.retract({ id, actor: op.actor ?? "admin", reason: op.reason ?? "wrong" });
      } else {
        score.reads++;
        const facts = await system.read({ subject: op.subject, ...(op.predicate ? { predicate: op.predicate } : {}), ...(op.space ? { space: op.space } : {}) });
        const values = facts.map((f) => f.value);
        const byPredicate = new Map<string, unknown[]>();
        for (const f of facts) byPredicate.set(f.predicate, [...(byPredicate.get(f.predicate) ?? []), f.value]);
        if ([...byPredicate.values()].some((vs) => vs.length > 1)) score.contradictions++;
        if (values.some((v) => badValues.some((b) => same(b, v)))) score.blastRadius++;
        const correct = op.expect === null ? values.length === 0 : values.length === 1 && same(values[0], op.expect);
        if (correct) score.correctReads++;
        else if (values.length > 0 && !values.some((v) => same(v, op.expect))) score.staleReads++;
        else if (values.length > 1) score.staleReads++;
      }
    } catch (e) {
      score.failures.push(`op ${i} (${op.op}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return score;
}

export async function runAll(system: MemoryUnderTest, scenarios: Scenario[]): Promise<Report> {
  const results: ScenarioScore[] = [];
  for (const s of scenarios) results.push(await runScenario(system, s));
  const totals = results.reduce(
    (t, s) => ({ reads: t.reads + s.reads, staleReads: t.staleReads + s.staleReads, contradictions: t.contradictions + s.contradictions, blastRadius: t.blastRadius + s.blastRadius, correctReads: t.correctReads + s.correctReads }),
    { reads: 0, staleReads: 0, contradictions: 0, blastRadius: 0, correctReads: 0 },
  );
  return { scenarios: results, totals };
}

/** The built-in scenarios: each is a memory incident a platform owner has actually had. */
export const SCENARIOS: Scenario[] = [
  {
    name: "correction: a superseded value must stop being served",
    ops: [
      { op: "write", key: "a", subject: "acct:42", predicate: "plan", value: "pro" },
      { op: "read", subject: "acct:42", predicate: "plan", expect: "pro" },
      { op: "write", key: "b", subject: "acct:42", predicate: "plan", value: "enterprise", supersedes: "a" },
      { op: "read", subject: "acct:42", predicate: "plan", expect: "enterprise" },
    ],
  },
  {
    name: "contradiction: two writers, one belief",
    ops: [
      { op: "write", key: "a", subject: "acct:42", predicate: "owner", value: "dana", actor: "support" },
      { op: "write", key: "b", subject: "acct:42", predicate: "owner", value: "mallory", actor: "intern", supersedes: "a" },
      { op: "read", subject: "acct:42", predicate: "owner", expect: "mallory" },
      { op: "retract", key: "b", reason: "poisoned tool result" },
      { op: "read", subject: "acct:42", predicate: "owner", expect: "dana" },
    ],
  },
  {
    name: "blast radius: a bad write is retracted and must not be served afterwards",
    ops: [
      { op: "write", key: "good", subject: "acct:7", predicate: "credit_limit", value: 1000 },
      { op: "write", key: "bad", subject: "acct:7", predicate: "credit_limit", value: 1000000, supersedes: "good", bad: true },
      { op: "read", subject: "acct:7", predicate: "credit_limit", expect: 1000000 },
      { op: "read", subject: "acct:7", predicate: "credit_limit", expect: 1000000 },
      { op: "retract", key: "bad" },
      { op: "read", subject: "acct:7", predicate: "credit_limit", expect: 1000 },
      { op: "read", subject: "acct:7", predicate: "credit_limit", expect: 1000 },
    ],
  },
  {
    name: "retraction with nothing underneath: the belief must disappear, not linger",
    ops: [
      { op: "write", key: "a", subject: "deal:9", predicate: "status", value: "signed", bad: true },
      { op: "read", subject: "deal:9", predicate: "status", expect: "signed" },
      { op: "retract", key: "a" },
      { op: "read", subject: "deal:9", predicate: "status", expect: null },
    ],
  },
];

export function formatReport(r: Report): string {
  const row = (s: Omit<ScenarioScore, "failures"> & { failures?: string[] }) => `${s.name.padEnd(76)} reads ${String(s.reads).padStart(2)}  correct ${String(s.correctReads).padStart(2)}  stale ${String(s.staleReads).padStart(2)}  contradictions ${String(s.contradictions).padStart(2)}  blast ${String(s.blastRadius).padStart(2)}`;
  const lines = r.scenarios.map((s) => row(s) + (s.failures.length ? `\n${s.failures.map((f) => `    ! ${f}`).join("\n")}` : ""));
  lines.push(row({ name: "TOTAL", ...r.totals }));
  return lines.join("\n");
}

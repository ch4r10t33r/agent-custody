// The harness exists to turn "our memory is governed" into numbers. It must give the ledger a clean score and give a
// plain overwrite store the failures a platform owner actually sees, or it measures nothing.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatReport, runAll, runScenario, SCENARIOS } from "../src/evals.ts";
import { ledgerUnderTest, overwriteStoreUnderTest } from "../src/evals-ledger.ts";
import { Ledger } from "../src/ledger.ts";

const ledger = () => ledgerUnderTest(new Ledger(join(mkdtempSync(join(tmpdir(), "evals-")), "ledger.jsonl")));

describe("memory-mutation evals", () => {
  it("the ledger passes every built-in scenario with no stale reads, contradictions, or blast radius after retraction", async () => {
    const r = await runAll(ledger(), SCENARIOS);
    expect(r.scenarios.flatMap((s) => s.failures)).toEqual([]);
    expect(r.totals.correctReads).toBe(r.totals.reads);
    expect(r.totals.staleReads).toBe(0);
    expect(r.totals.contradictions).toBe(0);
    // reads of a bad value before its retraction count as blast radius; the ledger serves it exactly while it is believed
    expect(r.totals.blastRadius).toBe(3);
  });

  it("an overwrite store loses what a retracted value displaced, and the harness says so", async () => {
    const r = await runAll(overwriteStoreUnderTest(), SCENARIOS);
    const byName = Object.fromEntries(r.scenarios.map((s) => [s.name.split(":")[0], s]));
    expect(byName.contradiction!.correctReads).toBe(1);
    expect(byName.contradiction!.staleReads).toBe(0);
    expect(byName["blast radius"]!.correctReads).toBe(2);
    expect(r.totals.correctReads).toBeLessThan(r.totals.reads);
  });

  it("a store that keeps both values on supersede is caught as a contradiction and a stale read", async () => {
    const rows: { id: string; subject: string; predicate: string; value: unknown }[] = [];
    const appendOnly = {
      write: (i: any) => {
        const id = `a${rows.length}`;
        rows.push({ id, subject: i.subject, predicate: i.predicate, value: i.value });
        return { id };
      },
      read: (q: any) => rows.filter((r) => r.subject === q.subject && (!q.predicate || r.predicate === q.predicate)),
      retract: (i: any) => {
        const k = rows.findIndex((r) => r.id === i.id);
        if (k >= 0) rows.splice(k, 1);
      },
    };
    const s = await runScenario(appendOnly, SCENARIOS[0]!);
    expect(s.contradictions).toBe(1);
    expect(s.staleReads).toBe(1);
    expect(s.correctReads).toBe(1);
  });

  it("scenario errors are reported per op, not thrown", async () => {
    const s = await runScenario(ledger(), { name: "broken", ops: [{ op: "retract", key: "never-written" }, { op: "read", subject: "x", expect: null }] });
    expect(s.failures).toEqual(["op 0 (retract): retract of unknown key never-written"]);
    expect(s.correctReads).toBe(1);
  });

  it("the report is one line per scenario plus a total", async () => {
    const text = formatReport(await runAll(ledger(), SCENARIOS));
    expect(text.split("\n")).toHaveLength(SCENARIOS.length + 1);
    expect(text).toMatch(/TOTAL.*reads 10.*correct 10/);
  });
});

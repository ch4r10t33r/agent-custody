// The ledger behind the harness interface, and a deliberately naive store to show that the metrics discriminate.
import { Ledger } from "./ledger.ts";
import type { MemoryUnderTest } from "./evals.ts";

export function ledgerUnderTest(ledger: Ledger): MemoryUnderTest {
  return {
    write: (i) => ({ id: ledger.assert({ ...i, provenance: "attested" }).fact.factId }),
    read: (q) => ledger.asOf({ ...q, include: "attested" }).map(({ subject, predicate, value }) => ({ subject, predicate, value })),
    retract: (i) => {
      ledger.retract({ factId: i.id, actor: i.actor, reason: i.reason });
    },
  };
}

/**
 * A key-value memory that overwrites on write and deletes on retract: the shape most memory layers have. It has no
 * idea what a retracted value displaced, so a retraction leaves a hole where the earlier belief should return.
 */
export function overwriteStoreUnderTest(): MemoryUnderTest {
  const rows = new Map<string, { id: string; subject: string; predicate: string; value: unknown }>();
  let n = 0;
  return {
    write: (i) => {
      const id = `m${++n}`;
      rows.set(`${i.space}|${i.subject}|${i.predicate}`, { id, subject: i.subject, predicate: i.predicate, value: i.value });
      return { id };
    },
    read: (q) => [...rows.values()].filter((r) => r.subject === q.subject && (!q.predicate || r.predicate === q.predicate)).map(({ subject, predicate, value }) => ({ subject, predicate, value })),
    retract: (i) => {
      for (const [k, r] of rows) if (r.id === i.id) rows.delete(k);
    },
  };
}

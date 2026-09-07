// Aspect: scoring memory mutations. Source: src/evals.ts, src/evals-ledger.ts
// Run:    node examples/04-evals.ts
// The same scenarios run against this ledger and against a plain overwrite store. The difference is the product.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatReport, runAll, SCENARIOS } from "../src/evals.ts";
import { ledgerUnderTest, overwriteStoreUnderTest } from "../src/evals-ledger.ts";
import { Ledger } from "../src/index.ts";

console.log("The ledger:");
const l = await runAll(ledgerUnderTest(new Ledger(join(mkdtempSync(join(tmpdir(), "evals-example-")), "ledger.jsonl"))), SCENARIOS);
console.log(formatReport(l));
console.log("\nA key-value store that overwrites on write and deletes on retract:");
const o = await runAll(overwriteStoreUnderTest(), SCENARIOS);
console.log(formatReport(o));
console.log("\nWhat the overwrite store cannot do: after a bad write is retracted, believe again what it displaced.");
if (l.totals.correctReads !== l.totals.reads || o.totals.correctReads >= o.totals.reads) throw new Error("unexpected");
console.log("\nOK");

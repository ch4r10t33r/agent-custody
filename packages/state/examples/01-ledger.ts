// Aspect: the fact ledger. Source: src/ledger.ts
// Run:    node examples/01-ledger.ts
// A support agent learns a customer's plan, a sales agent upgrades it, an intern agent gets it wrong, an admin undoes that.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/index.ts";

const file = join(mkdtempSync(join(tmpdir(), "state-example-")), "ledger.jsonl");
const ledger = new Ledger(file);
const show = (label: string, q: Parameters<Ledger["asOf"]>[0] = {}) =>
  console.log(`${label}: ${ledger.asOf({ subject: "acct:42", predicate: "plan", ...q }).map((f) => `${f.value} (by ${f.actor})`).join(", ") || "nothing"}`);

console.log("1. The support agent records the plan it saw in the CRM. The receipt id is what a gateway would fill in.");
const first = ledger.assert({ subject: "acct:42", predicate: "plan", value: "pro", space: "org", actor: "agent:support", source: { receiptId: "receipt-from-crm-lookup" } });
show("   believed now");

console.log("2. Sales upgrades the account. The old value stays true for its own interval.");
const upgrade = ledger.assert({ subject: "acct:42", predicate: "plan", value: "enterprise", space: "org", actor: "agent:sales", supersedes: first.fact.factId });
const upgradedAt = upgrade.fact.validFrom;
show("   believed now");
show("   believed for an instant before the upgrade", { validAt: new Date(new Date(upgradedAt).getTime() - 1).toISOString() });

console.log("3. An intern agent overwrites it from a bad tool result.");
const bad = ledger.assert({ subject: "acct:42", predicate: "plan", value: "free", space: "org", actor: "agent:intern", supersedes: upgrade.fact.factId, source: { receiptId: "receipt-from-poisoned-tool" } });
show("   believed now");

console.log("4. An admin retracts the bad write. The upgrade is believed again, and the mistake stays on the record.");
const undo = ledger.retract({ factId: bad.fact.factId, actor: "user:admin", reason: "poisoned tool result" });
show("   believed now");
show("   what was believed just before the retraction", { validAt: undo.txTime, txAt: new Date(new Date(undo.txTime).getTime() - 1).toISOString() });

console.log("5. The history of the bad fact, oldest first:");
for (const e of ledger.history(bad.fact.factId)) console.log(`   ${e.kind} at ${e.txTime} by ${e.kind === "assert" ? e.fact.actor : e.actor}${e.kind === "retract" ? `: ${e.reason}` : ""}`);

const now = ledger.asOf({ subject: "acct:42", predicate: "plan" });
if (now.length !== 1 || now[0]!.value !== "enterprise" || ledger.size !== 4) throw new Error("unexpected ledger state");
console.log("OK");

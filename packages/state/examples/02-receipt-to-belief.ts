// Aspect: receipts and state together. Source: @agent-custody/receipts, src/ledger.ts
// Run:    node examples/02-receipt-to-belief.ts        (after `bun run build` at the repository root)
// The whole loop a consumer runs: a tool call gets a signed receipt, the receipt is verified, and the belief the agent
// took from it is recorded in the ledger citing that receipt. When the belief turns out wrong, the receipt says where it came from.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkIssuer, generateKeyPair, loadPublicKey, loadSdkConfig, receiptIdOf, verifyBundle, writeKeyPair } from "@agent-custody/receipts";
import { Ledger } from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "receipt-to-belief-"));

console.log("1. A signing key for the agent's process, and an SDK config pointing at it.");
const { pubFile } = writeKeyPair(generateKeyPair(), join(dir, "keys"), "app");
writeFileSync(join(dir, "sdk.json"), JSON.stringify({ agentId: "support-bot", identity: { keyFile: "keys/app.key" }, receiptsDir: "receipts", logFile: "log.jsonl" }));
const issuer = createSdkIssuer(loadSdkConfig(join(dir, "sdk.json")));

console.log("2. The agent looks up a customer. The call is recorded as a signed receipt in a Merkle log.");
const crmLookup = async (args: { id: string }) => ({ id: args.id, plan: "pro" });
const args = { id: "acct:42" };
const result = await crmLookup(args);
const bundle = await issuer.record({ tool: "crm.lookup", args }, { status: "executed", result });
console.log(`   receipt ${receiptIdOf(bundle)} at log index ${bundle.inclusion.leafIndex}`);

console.log("3. Anyone with the public key can verify the receipt offline, including that it is in the log.");
const v = verifyBundle(bundle, { issuerKeys: [loadPublicKey(pubFile)], principalKeys: [], logFile: join(dir, "log.jsonl") });
console.log(`   verified: ${v.ok}, issuer kind: sdk, so every field is self-reported`);

console.log("4. What the agent now believes goes in the ledger, citing the receipt it came from.");
const ledger = new Ledger(join(dir, "ledger.jsonl"));
const belief = ledger.assert({ subject: "acct:42", predicate: "plan", value: result.plan, space: "org", actor: "support-bot", source: { receiptId: receiptIdOf(bundle) } });
console.log(`   believes plan=${ledger.asOf({ subject: "acct:42" })[0]!.value}, from receipt ${belief.fact.source.receiptId!.slice(0, 8)}`);

console.log("5. Later the belief turns out wrong. Retract it; the receipt still says exactly which call produced it.");
ledger.retract({ factId: belief.fact.factId, actor: "user:admin", reason: "CRM lookup returned a stale plan" });
console.log(`   believes now: ${ledger.asOf({ subject: "acct:42" }).length === 0 ? "nothing about acct:42" : "?"}; history keeps the receipt id ${belief.fact.source.receiptId!.slice(0, 8)}`);

if (!v.ok || ledger.asOf().length !== 0 || ledger.history(belief.fact.factId).length !== 2) throw new Error("unexpected state");
console.log("OK");

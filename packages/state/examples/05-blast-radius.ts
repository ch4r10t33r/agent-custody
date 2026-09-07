// Aspect: what relied on a wrong belief. Source: src/blast.ts, and the receipts gateway
// Run:    node examples/05-blast-radius.ts        (after `bun run build` at the repository root)
// The CRM said the wrong plan. The agent read it, then acted on it. Later the belief is retracted. The question a
// platform owner asks next is: what did the agent do with it, and what does it still believe because of it?
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDelegation, createGateway, generateKeyPair, loadConfig, writeKeyPair } from "@agent-custody/receipts";
import { Ledger, blastRadius, formatBlastRadius, loadReceipts } from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "blast-example-"));
const step = (n: number, s: string) => console.log(`\n${n}. ${s}`);
const value = (r: any) => JSON.parse(r.content[0].text);

step(1, "the memory server behind the gateway, as in example 03");
writeKeyPair(generateKeyPair(), join(dir, "keys"), "gateway");
const principalKp = generateKeyPair();
writeKeyPair(principalKp, join(dir, "keys"), "principal");
const now = Date.now();
writeFileSync(join(dir, "grant.json"), JSON.stringify(createDelegation(principalKp, { version: "0.1", principal: "user_456", agent: "support-agent", scopes: ["memory.write", "memory.read", "memory.retract", "memory.history"], issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3600_000).toISOString() })));
writeFileSync(join(dir, "policy.cedar"), `permit(principal, action, resource);\n`);
const ledgerFile = join(dir, "ledger.jsonl");
writeFileSync(join(dir, "gateway.json"), JSON.stringify({ identity: { keyFile: "keys/gateway.key" }, upstream: { command: process.execPath, args: [join(import.meta.dirname, "..", "src", "cli.ts"), "serve", "--ledger", ledgerFile] }, grantFile: "grant.json", trustedPrincipalKeys: ["keys/principal.pub"], policyFile: "policy.cedar", receiptsDir: "receipts", logFile: "log.jsonl" }));
const gw = await createGateway(loadConfig(join(dir, "gateway.json")));

step(2, "the agent records what the CRM said, reads it back, and acts on it: two beliefs derived from the first");
const plan = value(await gw.handleCall({ name: "memory.write", arguments: { subject: "acct:42", predicate: "plan", value: "enterprise", space: "team:support" } })).fact;
await gw.handleCall({ name: "memory.read", arguments: { subject: "acct:42" } });
await gw.handleCall({ name: "memory.write", arguments: { subject: "acct:42", predicate: "discount", value: "20%", space: "team:support" } });
await gw.handleCall({ name: "memory.write", arguments: { subject: "acct:42", predicate: "support_tier", value: "priority", space: "team:support" } });
console.log("   plan fact", plan.factId.slice(0, 8), "then a read, then two writes made after the agent had seen it");

step(3, "the CRM was wrong. The plan belief is retracted through the gateway");
await gw.handleCall({ name: "memory.retract", arguments: { factId: plan.factId, reason: "CRM sync bug: account is on the free plan" } });
await gw.close();

step(4, "blast radius: from the receipts' consumed facts and the ledger's source receipts, forward");
const b = await blastRadius(new Ledger(ledgerFile), loadReceipts(join(dir, "receipts")), plan.factId);
console.log(formatBlastRadius(b, plan.factId).split("\n").map((l) => "   " + l).join("\n"));
console.log("\n   the same from the shell: agent-custody-memory blast --ledger ledger.jsonl --receipts receipts --fact", plan.factId.slice(0, 8) + "…");

if (!b.retraction || b.derivedFacts.length !== 2 || b.stillBelieved.length !== 2 || b.receipts.length < 3) throw new Error("unexpected");
console.log("\nOK");

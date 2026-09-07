// Aspect: beliefs with custody. Source: src/server.ts, and the receipts gateway
// Run:    node examples/03-memory-behind-the-gateway.ts        (after `bun run build` at the repository root)
// The memory server runs as the gateway's upstream. Every write and read is policy-checked and receipted, and the
// ledger's source receipt id and actor come from the gateway, not from the agent.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDelegation, createGateway, generateKeyPair, loadConfig, loadPublicKey, RECEIPT_META_KEY, verifyBundle, writeKeyPair } from "@agent-custody/receipts";
import { Ledger } from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "memory-example-"));
const step = (n: number, s: string) => console.log(`\n${n}. ${s}`);
const value = (r: any) => JSON.parse(r.content[0].text);

step(1, "a gateway whose upstream is the memory server; the grant lets support-agent use the memory tools; policy confines writes to the team space");
writeKeyPair(generateKeyPair(), join(dir, "keys"), "gateway");
const principalKp = generateKeyPair();
const principal = writeKeyPair(principalKp, join(dir, "keys"), "principal");
const now = Date.now();
writeFileSync(join(dir, "grant.json"), JSON.stringify(createDelegation(principalKp, { version: "0.1", principal: "user_456", agent: "support-agent", scopes: ["memory.write", "memory.read", "memory.retract", "memory.history"], issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3600_000).toISOString() })));
writeFileSync(join(dir, "policy.cedar"), `permit(principal, action == Action::"memory.read", resource);
permit(principal, action == Action::"memory.history", resource);
permit(principal, action == Action::"memory.retract", resource);
permit(principal, action == Action::"memory.write", resource) when { context.args.space == "team:support" };
`);
const ledgerFile = join(dir, "ledger.jsonl");
writeFileSync(join(dir, "gateway.json"), JSON.stringify({ identity: { keyFile: "keys/gateway.key" }, upstream: { command: process.execPath, args: [join(import.meta.dirname, "..", "src", "cli.ts"), "serve", "--ledger", ledgerFile] }, grantFile: "grant.json", trustedPrincipalKeys: ["keys/principal.pub"], policyFile: "policy.cedar", receiptsDir: "receipts", logFile: "log.jsonl" }));
const gw = await createGateway(loadConfig(join(dir, "gateway.json")));
console.log("   tools the agent sees:", (await gw.listTools()).map((t) => t.name).join(", "));

step(2, "the agent records what it learned from the CRM; it claims to be someone else, and the ledger ignores that");
const w = await gw.handleCall({ name: "memory.write", arguments: { subject: "acct:42", predicate: "plan", value: "pro", space: "team:support", actor: "not-me" } });
const fact = value(w).fact;
console.log(`   actor=${fact.actor} (from the attested grant)  source.receiptId=${fact.source.receiptId.slice(0, 8)} (from the gateway)`);
console.log(`   the receipt id the agent got back: ${String(w._meta?.[RECEIPT_META_KEY]).slice(0, 8)}  same? ${fact.source.receiptId === w._meta?.[RECEIPT_META_KEY]}`);

step(3, "a write to the org space is outside policy: denied, never reaches the ledger, still receipted");
const d = await gw.handleCall({ name: "memory.write", arguments: { subject: "policy:refunds", predicate: "limit", value: 10 ** 9, space: "org" } });
console.log(`   ${(d.content[0] as any).text.slice(0, 60)}...  ledger events: ${new Ledger(ledgerFile).size}`);

step(4, "a read is receipted; the receipt's observed result lists exactly the fact ids the agent saw");
const r = await gw.handleCall({ name: "memory.read", arguments: { subject: "acct:42" } });
const bundle = JSON.parse(readFileSync(join(dir, "receipts", `${String(r._meta?.[RECEIPT_META_KEY])}.json`), "utf8"));
const v = verifyBundle(bundle, { issuerKeys: [loadPublicKey(join(dir, "keys", "gateway.pub"))], principalKeys: [loadPublicKey(principal.pubFile)], logFile: join(dir, "log.jsonl") });
const seen = JSON.parse((v.statement!.predicate.execution as any).result.content[0].text).facts.map((f: any) => f.factId);
console.log(`   verified=${v.ok}  facts seen by the agent: ${seen.map((s: string) => s.slice(0, 8)).join(", ")}`);

step(5, "the belief turns out wrong; the retraction cites its own receipt and the attested actor");
const x = await gw.handleCall({ name: "memory.retract", arguments: { factId: fact.factId, reason: "stale CRM value" } });
console.log(`   retracted by ${value(x).actor}, receipt ${value(x).source.receiptId.slice(0, 8)}; believed now: ${new Ledger(ledgerFile).asOf().length === 0 ? "nothing" : "?"}`);

await gw.close();
if (!v.ok || fact.actor !== "support-agent" || fact.source.receiptId !== w._meta?.[RECEIPT_META_KEY] || !d.isError) throw new Error("unexpected");
console.log("\nOK");

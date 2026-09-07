// Aspect: actions taken on a belief. Source: the receipts gateway with several upstreams, src/blast.ts
// Run:    node examples/06-actions-on-beliefs.ts        (after `bun run build` at the repository root)
// Memory and a payments API behind one gateway and one grant. The agent reads a belief, then refunds on the strength
// of it. When the belief is retracted, blast radius reaches the refund, not only the beliefs written afterwards.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDelegation, createGateway, generateKeyPair, loadConfig, writeKeyPair } from "@agent-custody/receipts";
import { Ledger, blastRadius, formatBlastRadius, loadReceipts } from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "actions-example-"));
const step = (n: number, s: string) => console.log(`\n${n}. ${s}`);
const value = (r: any) => JSON.parse(r.content[0].text);

step(1, "one gateway, two upstreams: the memory server and a payments API; one grant covers both");
writeKeyPair(generateKeyPair(), join(dir, "keys"), "gateway");
const principalKp = generateKeyPair();
writeKeyPair(principalKp, join(dir, "keys"), "principal");
const now = Date.now();
writeFileSync(join(dir, "grant.json"), JSON.stringify(createDelegation(principalKp, { version: "0.1", principal: "user_456", agent: "support-agent", scopes: ["memory.write", "memory.read", "memory.retract", "customer.lookup", "stripe.refund"], issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3600_000).toISOString() })));
writeFileSync(join(dir, "policy.cedar"), `permit(principal, action, resource);\n`);
const ledgerFile = join(dir, "ledger.jsonl");
const stripe = resolve(import.meta.dirname, "..", "..", "receipts", "scripts", "fake-stripe.ts");
writeFileSync(join(dir, "gateway.json"), JSON.stringify({
  identity: { keyFile: "keys/gateway.key" },
  upstreams: [
    { name: "memory", command: process.execPath, args: [join(import.meta.dirname, "..", "src", "cli.ts"), "serve", "--ledger", ledgerFile] },
    { name: "payments", command: process.execPath, args: [stripe] },
  ],
  grantFile: "grant.json", trustedPrincipalKeys: ["keys/principal.pub"], policyFile: "policy.cedar", receiptsDir: "receipts", logFile: "log.jsonl",
}));
const gw = await createGateway(loadConfig(join(dir, "gateway.json")));
console.log("   tools:", (await gw.listTools()).map((t) => t.name).join(", "));

step(2, "the agent records what the CRM said, reads it back, and refunds on the strength of it");
const plan = value(await gw.handleCall({ name: "memory.write", arguments: { subject: "cust_123", predicate: "plan", value: "enterprise", space: "team:support" } })).fact;
await gw.handleCall({ name: "memory.read", arguments: { subject: "cust_123" } });
const refund = await gw.handleCall({ name: "stripe.refund", arguments: { customer_id: "cust_123", amount: 50000 } });
console.log("   refund:", value(refund).status, "receipt", String(refund._meta?.["agent-custody/receipt"]).slice(0, 8));

step(3, "the CRM was wrong; the belief is retracted, and blast radius names the refund");
await gw.handleCall({ name: "memory.retract", arguments: { factId: plan.factId, reason: "CRM sync bug" } });
await gw.close();
const b = await blastRadius(new Ledger(ledgerFile), loadReceipts(join(dir, "receipts")), plan.factId);
console.log(formatBlastRadius(b, plan.factId).split("\n").map((l) => "   " + l).join("\n"));

if (!b.receipts.some((r) => r.tool === "stripe.refund") || !b.retraction) throw new Error("unexpected");
console.log("\nOK");

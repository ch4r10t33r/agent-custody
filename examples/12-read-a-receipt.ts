// Aspect: what is inside a receipt. Source: src/receipt.ts
// Run:    npx tsx examples/12-read-a-receipt.ts
//
// A bundle is three things: a signed statement, a signed tree head, and an inclusion proof. This walks one.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { createGateway, RECEIPT_META_KEY } from "../src/gateway.ts";
import type { ReceiptBundle, ReceiptStatement, TreeHead } from "../src/receipt.ts";
import { buildFixture } from "../scripts/fixture.ts";
import { out, step } from "./_out.ts";

const fx = buildFixture(out("12-receipt"));
const gw = await createGateway(loadConfig(fx.configFile));
const r = await gw.handleCall({ name: "stripe.refund", arguments: { customer_id: "cust_123", amount: 50000 }, _meta: { "agent-receipts/model": "claude-fable-5-1" } });
await gw.close();
const bundle = JSON.parse(readFileSync(join(fx.receiptsDir, `${String(r._meta?.[RECEIPT_META_KEY])}.json`), "utf8")) as ReceiptBundle;

step(1, "the bundle's three parts");
console.log("   envelope.payloadType:", bundle.envelope.payloadType, "signed by", bundle.envelope.signatures[0]!.keyid.slice(0, 12) + "…");
console.log("   treeHead.payloadType:", bundle.treeHead.payloadType);
console.log("   inclusion:", JSON.stringify(bundle.inclusion));

step(2, "decode the statement: in-toto v1, subject digest = sha256 of the arguments");
const st = JSON.parse(Buffer.from(bundle.envelope.payload, "base64").toString()) as ReceiptStatement;
console.log("   _type:", st._type);
console.log("   predicateType:", st.predicateType);
console.log("   subject:", JSON.stringify(st.subject[0]));

step(3, "the predicate, field by field, with provenance");
const p = st.predicate;
const show = (name: string, prov: string, value: unknown) => console.log(`   ${name.padEnd(12)} ${prov.padEnd(9)} ${typeof value === "string" ? value : JSON.stringify(value)}`);
show("issuer", "-", p.issuer);
show("principal", p.principal.provenance, p.principal.id);
show("agent", p.agent.provenance, p.agent.id);
show("delegation", p.delegation?.provenance ?? "-", p.delegation ? "embedded DSSE envelope signed by the principal" : "(none)");
show("session", p.session.provenance, { id: p.session.id, toolUseId: p.session.toolUseId });
show("model", p.model.provenance, p.model.id);
show("tool", p.tool.provenance, p.tool.name);
show("request", p.request.provenance, { args: p.request.args, argsDigest: p.request.argsDigest.slice(0, 12) + "…" });
for (const [k, f] of Object.entries(p.facts)) show(`facts.${k}`, f.provenance, { via: f.tool, value: f.value });
show("policy", p.policy?.provenance ?? "-", p.policy ? { decision: p.policy.decision, reasons: p.policy.reasons, policyDigest: p.policy.policyDigest.slice(0, 12) + "…" } : null);
show("execution", p.execution.provenance, p.execution.status);

step(4, "the tree head the issuer signed when it appended this receipt");
const head = JSON.parse(Buffer.from(bundle.treeHead.payload, "base64").toString()) as TreeHead;
console.log("   ", JSON.stringify(head));

step(5, "what the three labels mean");
console.log("   attested  signed by a key other than the issuer's: here the principal's grant");
console.log("   observed  the gateway obtained it itself: the customer lookup, the policy decision, the upstream result");
console.log("   claimed   the agent supplied it and nobody checked: the arguments, the model id");

console.log("\nOK");

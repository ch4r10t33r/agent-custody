// Aspect: delegated authority. Source: src/delegation.ts
// Run:    npx tsx examples/02-delegation-grant.ts
//
// A principal (a person or an organisation) signs a grant: this agent may use these tools between these times.
// The gateway refuses to start without a valid grant, and every gateway receipt embeds the grant it enforced.
import { generateKeyPair } from "../src/crypto.ts";
import { createDelegation, delegationValidAt, verifyDelegation } from "../src/delegation.ts";
import { step } from "./_out.ts";

const principal = generateKeyPair();
const stranger = generateKeyPair();
const now = Date.now();

step(1, "the principal signs a grant (CLI: node src/cli.ts grant --key principal.key --principal user_456 --agent support-agent --scopes customer.lookup,stripe.refund --ttl-hours 8 --out grant.json)");
const grant = createDelegation(principal, {
  version: "0.1",
  principal: "user_456",
  agent: "support-agent",
  scopes: ["customer.lookup", "stripe.refund"],
  issuedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 8 * 3600_000).toISOString(),
});
console.log("   envelope payloadType:", grant.payloadType);

step(2, "a verifier who trusts the principal's public key accepts it");
const ok = verifyDelegation(grant, [principal]);
console.log("   ok:", ok.ok, ok.ok ? `agent=${ok.delegation.agent} scopes=[${ok.delegation.scopes.join(", ")}]` : ok.error);

step(3, "a verifier who trusts a different key does not");
const bad = verifyDelegation(grant, [stranger]);
console.log("   ok:", bad.ok, bad.ok ? "" : `(${bad.error})`);

step(4, "validity is a window; receipts are checked against the receipt's own timestamp");
if (ok.ok) {
  console.log("   valid now:", delegationValidAt(ok.delegation, new Date().toISOString()));
  console.log("   valid in 9 hours:", delegationValidAt(ok.delegation, new Date(now + 9 * 3600_000).toISOString()));
}

step(5, "scopes are enforced by the gateway before any policy runs; a tool outside the grant is denied with a receipt");
console.log("   stripe.payout in scopes:", ok.ok && ok.delegation.scopes.includes("stripe.payout"));

console.log("\nOK");

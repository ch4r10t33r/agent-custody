// Builds a complete working directory for the gateway: keys, a delegation grant, a Cedar policy, and a config.
// Shared by the demo and the end-to-end test.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateKeyPair, writeKeyPair } from "../src/crypto.ts";
import { createDelegation } from "../src/delegation.ts";

export const POLICY = `// Reads of customer records are permitted to any agent holding the scope.
permit(principal, action == Action::"customer.lookup", resource);

// Refunds: at most £1,000 (100000 pence) and only for customers the gateway itself verified.
// context.facts.customer comes from the gateway's own customer.lookup call, never from the agent.
permit(principal, action == Action::"stripe.refund", resource)
when {
  context.args.amount <= 100000 &&
  context.facts has customer &&
  context.facts.customer.verified == true
};
`;

export interface Fixture {
  dir: string;
  configFile: string;
  gatewayPub: string;
  principalPub: string;
  receiptsDir: string;
  logFile: string;
}

export function buildFixture(dir: string, ttlMs = 3600_000): Fixture {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const gateway = writeKeyPair(generateKeyPair(), join(dir, "keys"), "gateway");
  const principalKp = generateKeyPair();
  const principal = writeKeyPair(principalKp, join(dir, "keys"), "principal");

  const now = Date.now();
  const grant = createDelegation(principalKp, {
    version: "0.1",
    principal: "user_456",
    agent: "support-agent",
    scopes: ["customer.lookup", "stripe.refund"],
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  });
  writeFileSync(join(dir, "grant.json"), JSON.stringify(grant, null, 2));
  writeFileSync(join(dir, "policy.cedar"), POLICY);

  const config = {
    identity: { keyFile: "keys/gateway.key" },
    upstream: { command: process.execPath, args: ["--import", "tsx", resolve(import.meta.dirname, "fake-stripe.ts")] },
    grantFile: "grant.json",
    trustedPrincipalKeys: ["keys/principal.pub"],
    policyFile: "policy.cedar",
    facts: [{ name: "customer", tool: "customer.lookup", args: { customer_id: "$args.customer_id" }, forTools: ["stripe.refund"] }],
    receiptsDir: "receipts",
    logFile: "log.jsonl",
  };
  const configFile = join(dir, "gateway.json");
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  return { dir, configFile, gatewayPub: gateway.pubFile, principalPub: principal.pubFile, receiptsDir: join(dir, "receipts"), logFile: join(dir, "log.jsonl") };
}

// Aspect: an agentic CI/CD merge gate with evidence an auditor accepts. Source: src/gateway.ts, src/rest.ts, src/verify.ts
// Run:    node examples/24-agentic-cicd-merge-gate.ts
//
// The pipeline many teams are drawing: writer agents open pull requests, reviewer agents and deterministic gates
// check them, a risk tier decides whether the merge is automatic, needs a human, or needs two. The volume problem
// is that SOC 2 and ISO 27001 ask for authorized, reviewed changes, and a human on every PR does not scale. The
// compliance problem is that a pipeline's own audit trail is written by the pipeline. This example puts the gateway
// between a release agent and the git host: the tier is a policy evaluated on facts the gateway fetches itself
// (the diff, the gate results, who approved), the merge is committed to the log before it happens, and every
// decision, allowed or refused, is a signed receipt a stranger verifies with public keys. The host is a stand-in.
import { createServer } from "node:http";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { generateKeyPair, loadPublicKey, writeKeyPair } from "../src/crypto.ts";
import { createDelegation } from "../src/delegation.ts";
import { createGateway, RECEIPT_META_KEY } from "../src/gateway.ts";
import type { ReceiptBundle, ReceiptStatement } from "../src/receipt.ts";
import { verifyBundle } from "../src/verify.ts";
import { out, step } from "./_out.ts";

// ---- a stand-in git host: pull requests with their diff facts, gate results, reviews; merge; promote ----
type PR = { number: number; title: string; additions: number; touches_sensitive: boolean; all_green: boolean; reviewer_agent: "approve" | "request_changes"; human_approvals: string[]; merged: boolean };
const prs = new Map<number, PR>([
  [101, { number: 101, title: "Fix typo in README and bump copy", additions: 12, touches_sensitive: false, all_green: true, reviewer_agent: "approve", human_approvals: [], merged: false }],
  [102, { number: 102, title: "Refactor billing retries", additions: 640, touches_sensitive: false, all_green: true, reviewer_agent: "approve", human_approvals: [], merged: false }],
  [103, { number: 103, title: "Rotate production signing key", additions: 40, touches_sensitive: true, all_green: true, reviewer_agent: "approve", human_approvals: ["alice"], merged: false }],
]);
const promotions: string[] = [];
const host = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = (status: number, v: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    if (req.headers.authorization !== "Bearer ghs_example") return json(401, { error: "no token" });
    const m = /^\/repos\/app\/pulls\/(\d+)(\/\w+)?$/.exec(req.url ?? "");
    const pr = m ? prs.get(Number(m[1])) : undefined;
    if (m && !pr) return json(404, { error: "no such pull request" });
    if (req.method === "GET" && pr && !m![2]) return json(200, { number: pr.number, title: pr.title, additions: pr.additions, touches_sensitive: pr.touches_sensitive });
    if (req.method === "GET" && pr && m![2] === "/checks") return json(200, { all_green: pr.all_green, gates: ["sast", "sca", "secrets", "tests", "iac", "license"] });
    if (req.method === "GET" && pr && m![2] === "/reviews") return json(200, { reviewer_agent: pr.reviewer_agent, human_approvals: pr.human_approvals, human_count: pr.human_approvals.length });
    if (req.method === "POST" && pr && m![2] === "/merge") { pr.merged = true; return json(200, { merged: true, sha: `deadbeef${pr.number}` }); }
    if (req.method === "POST" && req.url === "/deploy/promote") { const { env } = JSON.parse(body); promotions.push(env); return json(200, { promoted: env }); }
    json(404, { error: "no such route" });
  });
});
await new Promise<void>((r) => host.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${(host.address() as { port: number }).port}`;

// ---- the gateway's working directory: keys, the release manager's grant to the release agent, the policy, the config ----
const dir = out("24-merge-gate");
mkdirSync(join(dir, "keys"), { recursive: true });
const gateway = writeKeyPair(generateKeyPair(), join(dir, "keys"), "gateway");
const principalKp = generateKeyPair();
const principal = writeKeyPair(principalKp, join(dir, "keys"), "release-manager");
const scopes = ["pr.get", "pr.checks", "pr.reviews", "pr.merge", "deploy.promote"];
writeFileSync(join(dir, "grant.json"), JSON.stringify(createDelegation(principalKp, { version: "0.1", principal: "release-manager@example.com", agent: "release-agent", scopes, issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() }), null, 2));
const POLICY = `// The release agent may read a pull request, its gate results, and its reviews.
permit(principal, action in [Action::"pr.get", Action::"pr.checks", Action::"pr.reviews"], resource);

// Low risk: small, nothing sensitive, every deterministic gate green, the reviewer agent approves. Merges on its own.
permit(principal, action == Action::"pr.merge", resource)
when { context.facts.checks.all_green && context.facts.reviews.reviewer_agent == "approve"
    && context.facts.pr.additions <= 200 && !context.facts.pr.touches_sensitive };

// Medium risk: larger, nothing sensitive, gates green, reviewer agent approves, and at least one human CODEOWNER approved.
permit(principal, action == Action::"pr.merge", resource)
when { context.facts.checks.all_green && context.facts.reviews.reviewer_agent == "approve"
    && !context.facts.pr.touches_sensitive && context.facts.reviews.human_count >= 1 };

// High risk (sensitive paths): no permit, so no agent merges it. Two humans merge it in the host under dual control.

// Promotion: anywhere but production on the agent's own authority.
permit(principal, action == Action::"deploy.promote", resource) when { context.args.env != "prod" };
`;
writeFileSync(join(dir, "policy.cedar"), POLICY);
process.env.EXAMPLE_GIT_HOST_BEARER = "Bearer ghs_example";
const obj = (props: Record<string, { type: string }>, required: string[]) => ({ type: "object", properties: props, required });
const config = {
  identity: { keyFile: "keys/gateway.key" },
  grantFile: "grant.json",
  trustedPrincipalKeys: ["keys/release-manager.pub"],
  policyFile: "policy.cedar",
  upstream: { rest: { baseUrl, headerEnv: { authorization: "EXAMPLE_GIT_HOST_BEARER" }, tools: [
    { name: "pr.get", method: "GET", path: "/repos/app/pulls/{number}", inputSchema: obj({ number: { type: "string" } }, ["number"]) },
    { name: "pr.checks", method: "GET", path: "/repos/app/pulls/{number}/checks", inputSchema: obj({ number: { type: "string" } }, ["number"]) },
    { name: "pr.reviews", method: "GET", path: "/repos/app/pulls/{number}/reviews", inputSchema: obj({ number: { type: "string" } }, ["number"]) },
    { name: "pr.merge", method: "POST", path: "/repos/app/pulls/{number}/merge", description: "Merge a pull request", inputSchema: obj({ number: { type: "string" } }, ["number"]) },
    { name: "deploy.promote", method: "POST", path: "/deploy/promote", description: "Promote the current release to an environment", inputSchema: obj({ env: { type: "string" } }, ["env"]) },
  ] } },
  // the tier is decided on what the gateway fetched, never on what the agent said about the PR
  facts: [
    { name: "pr", tool: "pr.get", args: { number: "$args.number" }, forTools: ["pr.merge"] },
    { name: "checks", tool: "pr.checks", args: { number: "$args.number" }, forTools: ["pr.merge"] },
    { name: "reviews", tool: "pr.reviews", args: { number: "$args.number" }, forTools: ["pr.merge"] },
  ],
  // a merge and a promotion are committed to the log before they go out; if the log refuses, they do not happen
  precommit: ["pr.merge", "deploy.promote"],
  receiptsDir: "receipts",
  logFile: "log.jsonl",
};
writeFileSync(join(dir, "gateway.json"), JSON.stringify(config, null, 2));
const gw = await createGateway(loadConfig(join(dir, "gateway.json")));
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await gw.handleCall({ name, arguments: args });
  return { text: (r.content[0] as { text: string }).text, id: String(r._meta?.[RECEIPT_META_KEY]), isError: !!r.isError };
};

step(1, "PR 101, low risk: 12 lines, nothing sensitive, gates green, reviewer agent approves. The release agent merges it on its own; the authorization is logged first");
const low = await call("pr.merge", { number: "101" });
console.log(`   ${low.isError ? "refused" : "merged "}  ${low.text.slice(0, 80)}`);

step(2, "PR 102, medium risk: 640 lines. No human has approved, so the merge is refused before it reaches the host");
const med1 = await call("pr.merge", { number: "102" });
console.log(`   ${med1.isError ? "refused" : "merged "}  ${med1.text.slice(0, 110)}`);
prs.get(102)!.human_approvals.push("alice");
console.log("   alice, a CODEOWNER, approves in the host");
const med2 = await call("pr.merge", { number: "102" });
console.log(`   ${med2.isError ? "refused" : "merged "}  ${med2.text.slice(0, 80)}  (the receipt names alice as the approver the gateway saw)`);

step(3, "PR 103, high risk: it touches a production signing key. One human approved; the policy has no permit for an agent here, so it is refused and two humans merge it under dual control in the host");
const high = await call("pr.merge", { number: "103" });
console.log(`   ${high.isError ? "refused" : "merged "}  ${high.text.slice(0, 110)}`);

step(4, "promotion: staging on the agent's own authority, production refused");
const stg = await call("deploy.promote", { env: "staging" });
const prod = await call("deploy.promote", { env: "prod" });
console.log(`   staging ${stg.isError ? "refused" : "promoted"}; prod ${prod.isError ? "refused" : "promoted"}`);
await gw.close();
host.close();
if (!prs.get(101)!.merged || prs.get(103)!.merged || promotions.includes("prod")) throw new Error("the gate did not hold");

step(5, "the evidence an auditor asks for, from the receipts alone: what was merged, under which tier, by whose authority, verified with public keys");
const keys = { issuerKeys: [loadPublicKey(gateway.pubFile)], principalKeys: [loadPublicKey(principal.pubFile)], logFile: join(dir, "log.jsonl") };
const rows: { at: string; line: string }[] = [];
for (const f of readdirSync(join(dir, "receipts")).filter((n) => n.endsWith(".json") && !n.endsWith(".authorization.json"))) {
  const bundle = JSON.parse(readFileSync(join(dir, "receipts", f), "utf8")) as ReceiptBundle;
  const r = await verifyBundle(bundle, keys);
  if (!r.ok) throw new Error(`${f} does not verify: ${r.checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}`);
  const p = (JSON.parse(Buffer.from(bundle.envelope.payload, "base64").toString()) as ReceiptStatement).predicate;
  if (p.tool.name !== "pr.merge" && p.tool.name !== "deploy.promote") continue;
  const reviews = p.facts.reviews?.value as { human_approvals?: string[] } | undefined;
  const tier = p.tool.name !== "pr.merge" ? "" : (p.facts.pr?.value as { touches_sensitive: boolean; additions: number }).touches_sensitive ? "high" : (p.facts.pr?.value as { additions: number }).additions > 200 ? "medium" : "low";
  // a call that ran carries the authorization the gateway logged before forwarding it; the verifier checked it precedes the receipt
  const auth = p.authorization ? `authorized at leaf ${p.authorization.inclusion.leafIndex}, executed at leaf ${bundle.inclusion.leafIndex}` : p.execution.status === "denied" ? "nothing forwarded" : "no precommit";
  rows.push({ at: p.timestamp, line: `   ${p.timestamp.slice(11, 23)}  ${p.tool.name.padEnd(15)} ${JSON.stringify(p.request.args).padEnd(18)} ${tier.padEnd(7)} ${p.execution.status.padEnd(9)} authority ${p.principal.id} (${p.principal.provenance})  approvers ${JSON.stringify(reviews?.human_approvals ?? [])}  policy ${p.policy?.policyDigest.slice(0, 12)}  ${auth}  VERIFIED` });
}
rows.sort((x, y) => x.at.localeCompare(y.at));
console.log(rows.map((r) => r.line).join("\n"));
if (!rows.some((r) => r.line.includes("authorized at leaf"))) throw new Error("no merge carried its pre-logged authorization");
console.log("   SOC 2 CC8.1 and ISO 27001 A.8.32 ask that changes are authorized, tested, and approved per a defined process, with evidence. Each line is that evidence, signed by a key the agent does not hold, checkable without us.");

if (rows.length !== 6) throw new Error(`expected six consequential calls, saw ${rows.length}`);
console.log("\nOK");

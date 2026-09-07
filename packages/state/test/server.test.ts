// The memory server exists so beliefs get the same custody as actions. Two settings: driven directly over an
// in-memory transport, and behind the real receipts gateway, where the receipt id and the attested agent reach it in
// _meta and a caller's own claims about them are ignored.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createDelegation, createGateway, generateKeyPair, loadConfig, loadPublicKey, RECEIPT_META_KEY, verifyBundle, writeKeyPair, type Gateway } from "@agent-custody/receipts";
import { Ledger } from "../src/ledger.ts";
import { createMemoryServer } from "../src/server.ts";
import { blastRadius, loadReceipts } from "../src/blast.ts";

const value = (r: CallToolResult) => JSON.parse((r.content[0] as { text: string }).text);

describe("memory server, driven directly", () => {
  let client: Client;
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "memory-direct-"));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMemoryServer(new Ledger(join(dir, "ledger.jsonl"))).connect(a);
    client = new Client({ name: "test", version: "0" });
    await client.connect(b);
  });
  afterAll(() => client.close());

  it("lists the four tools", async () => {
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["memory.write", "memory.read", "memory.confirm", "memory.retract", "memory.history"]);
  });

  it("write, read, supersede, retract, history; the source is null, the actor is whatever the caller claims, and the fact is quarantined", async () => {
    const w = value((await client.callTool({ name: "memory.write", arguments: { subject: "acct:42", predicate: "plan", value: "pro", space: "org", actor: "agent:support" } })) as CallToolResult);
    expect(w.fact.source).toEqual({ receiptId: null });
    expect(w.fact.actor).toBe("agent:support");
    expect(w.fact.provenance).toBe("claimed");
    const w2 = value((await client.callTool({ name: "memory.write", arguments: { subject: "acct:42", predicate: "plan", value: "enterprise", space: "org", supersedes: w.fact.factId } })) as CallToolResult);
    expect(w2.fact.actor).toBe("anonymous");
    expect(value((await client.callTool({ name: "memory.read", arguments: { subject: "acct:42" } })) as CallToolResult).facts).toEqual([]);
    expect(value((await client.callTool({ name: "memory.read", arguments: { subject: "acct:42", includeClaimed: true } })) as CallToolResult).facts.map((f: any) => f.value)).toEqual(["enterprise"]);
    const refused = (await client.callTool({ name: "memory.confirm", arguments: { factId: w2.fact.factId } })) as CallToolResult;
    expect(refused.isError).toBe(true);
    expect((refused.content[0] as any).text).toMatch(/cannot lift a fact out of quarantine/);
    value((await client.callTool({ name: "memory.retract", arguments: { factId: w2.fact.factId, reason: "wrong" } })) as CallToolResult);
    expect(value((await client.callTool({ name: "memory.read", arguments: { subject: "acct:42", includeClaimed: true } })) as CallToolResult).facts.map((f: any) => f.value)).toEqual(["pro"]);
    expect(value((await client.callTool({ name: "memory.history", arguments: { factId: w2.fact.factId } })) as CallToolResult).events.map((e: any) => e.kind)).toEqual(["assert", "retract"]);
  });

  it("rejects bad arguments and unknown facts as tool errors, writing nothing", async () => {
    const before = readFileSync(join(dir, "ledger.jsonl"), "utf8");
    const bad = (await client.callTool({ name: "memory.write", arguments: { subject: "", predicate: "p", value: 1, space: "org" } })) as CallToolResult;
    expect(bad.isError).toBe(true);
    expect((bad.content[0] as any).text).toMatch(/invalid arguments: subject/);
    const gone = (await client.callTool({ name: "memory.retract", arguments: { factId: "nope", reason: "x" } })) as CallToolResult;
    expect(gone.isError).toBe(true);
    expect(readFileSync(join(dir, "ledger.jsonl"), "utf8")).toBe(before);
  });

  it("with requireGateway, a call carrying no receipt id is refused", async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMemoryServer(new Ledger(join(dir, "strict.jsonl")), { requireGateway: true }).connect(a);
    const strict = new Client({ name: "test", version: "0" });
    await strict.connect(b);
    const r = (await strict.callTool({ name: "memory.write", arguments: { subject: "s", predicate: "p", value: 1, space: "org" } })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect((r.content[0] as any).text).toMatch(/only through the receipts gateway/);
    await strict.close();
  });
});

describe("memory server behind the receipts gateway", () => {
  let dir: string;
  let gw: Gateway;
  let ledgerFile: string;
  let seeded: string;
  let gatewayPub: string;
  let principalPub: string;
  const POLICY = `permit(principal, action == Action::"memory.read", resource);
permit(principal, action == Action::"memory.history", resource);
permit(principal, action == Action::"memory.write", resource) when { context.args.space == "team:support" };
permit(principal, action == Action::"memory.retract", resource);
permit(principal, action == Action::"memory.confirm", resource);
`;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "memory-gateway-"));
    const gateway = writeKeyPair(generateKeyPair(), join(dir, "keys"), "gateway");
    const principalKp = generateKeyPair();
    const principal = writeKeyPair(principalKp, join(dir, "keys"), "principal");
    gatewayPub = gateway.pubFile;
    principalPub = principal.pubFile;
    const now = Date.now();
    writeFileSync(join(dir, "grant.json"), JSON.stringify(createDelegation(principalKp, { version: "0.1", principal: "user_456", agent: "support-agent", scopes: ["memory.write", "memory.read", "memory.retract", "memory.history", "memory.confirm"], issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3600_000).toISOString() })));
    writeFileSync(join(dir, "policy.cedar"), POLICY);
    ledgerFile = join(dir, "ledger.jsonl");
    // A ledger that already holds a self-reported fact before it is put under the gateway: the quarantine case.
    seeded = new Ledger(ledgerFile).assert({ subject: "acct:99", predicate: "owner", value: "dana", space: "team:support", actor: "sdk-bot" }).fact.factId;
    writeFileSync(join(dir, "gateway.json"), JSON.stringify({
      identity: { keyFile: "keys/gateway.key" },
      upstream: { command: process.execPath, args: [join(import.meta.dirname, "..", "src", "cli.ts"), "serve", "--ledger", ledgerFile] },
      grantFile: "grant.json",
      trustedPrincipalKeys: ["keys/principal.pub"],
      policyFile: "policy.cedar",
      receiptsDir: "receipts",
      logFile: "log.jsonl",
    }));
    gw = await createGateway(loadConfig(join(dir, "gateway.json")));
  });
  afterAll(() => gw.close());

  const receiptOf = (r: CallToolResult) => JSON.parse(readFileSync(join(dir, "receipts", `${String(r._meta?.[RECEIPT_META_KEY])}.json`), "utf8"));

  it("a write's source is the gateway's receipt id and its actor is the grant's agent, whatever the caller claimed", async () => {
    const r = await gw.handleCall({ name: "memory.write", arguments: { subject: "acct:42", predicate: "plan", value: "pro", space: "team:support", actor: "someone-else" } });
    expect(r.isError).toBeFalsy();
    const fact = value(r).fact;
    expect(fact.source.receiptId).toBe(String(r._meta?.[RECEIPT_META_KEY]));
    expect(fact.actor).toBe("support-agent");
    expect(fact.provenance).toBe("attested");
    const v = verifyBundle(receiptOf(r), { issuerKeys: [loadPublicKey(gatewayPub)], principalKeys: [loadPublicKey(principalPub)], logFile: join(dir, "log.jsonl") });
    expect(v.ok).toBe(true);
    expect(v.statement?.predicate.tool).toEqual({ name: "memory.write", provenance: "observed" });
    expect(new Ledger(ledgerFile).asOf({ subject: "acct:42" })[0]?.source.receiptId).toBe(fact.source.receiptId);
  });

  it("a write the policy forbids never reaches the ledger and still gets a denial receipt", async () => {
    const before = new Ledger(ledgerFile).size;
    const r = await gw.handleCall({ name: "memory.write", arguments: { subject: "policy:refunds", predicate: "limit", value: 10 ** 9, space: "org" } });
    expect(r.isError).toBe(true);
    expect((r.content[0] as any).text).toMatch(/Denied by policy/);
    expect(new Ledger(ledgerFile).size).toBe(before);
    expect(verifyBundle(receiptOf(r), { issuerKeys: [loadPublicKey(gatewayPub)], principalKeys: [loadPublicKey(principalPub)] }).statement?.predicate.execution.status).toBe("denied");
  });

  it("reads are receipted too, and the receipt's observed result carries the fact ids the agent saw", async () => {
    const r = await gw.handleCall({ name: "memory.read", arguments: { subject: "acct:42" } });
    const facts = value(r).facts;
    expect(facts).toHaveLength(1);
    expect(facts[0].subject).toBe("acct:42");
    const st = verifyBundle(receiptOf(r), { issuerKeys: [loadPublicKey(gatewayPub)], principalKeys: [loadPublicKey(principalPub)] }).statement!;
    const seen = JSON.parse((st.predicate.execution as any).result.content[0].text).facts.map((f: any) => f.factId);
    expect(seen).toEqual([facts[0].factId]);
    expect(st.predicate.execution.provenance).toBe("observed");
  });

  it("a claimed fact already in the ledger is invisible to the agent until confirmed through the gateway, and the confirmation cites its receipt", async () => {
    expect(value(await gw.handleCall({ name: "memory.read", arguments: { subject: "acct:99" } })).facts).toEqual([]);
    expect(value(await gw.handleCall({ name: "memory.read", arguments: { subject: "acct:99", includeClaimed: true } })).facts.map((f: any) => f.provenance)).toEqual(["claimed"]);
    const r = await gw.handleCall({ name: "memory.confirm", arguments: { factId: seeded } });
    expect(r.isError).toBeFalsy();
    expect(value(r).actor).toBe("support-agent");
    expect(value(r).source.receiptId).toBe(String(r._meta?.[RECEIPT_META_KEY]));
    expect(value(await gw.handleCall({ name: "memory.read", arguments: { subject: "acct:99" } })).facts.map((f: any) => f.provenance)).toEqual(["attested"]);
  });

  it("receipts carry the facts the agent had been shown, and blast radius walks from a fact to every call and belief that relied on it", async () => {
    const plan = new Ledger(ledgerFile).asOf({ subject: "acct:42" })[0]!;
    const readBefore = await gw.handleCall({ name: "memory.read", arguments: { subject: "acct:42" } });
    const st = (id: string) => verifyBundle(receiptOf({ _meta: { [RECEIPT_META_KEY]: id } } as any), { issuerKeys: [loadPublicKey(gatewayPub)], principalKeys: [loadPublicKey(principalPub)] }).statement!.predicate as any;
    // the read itself was made before the agent had been shown anything in this test's session except earlier reads
    expect(st(String(readBefore._meta?.[RECEIPT_META_KEY])).consumed.provenance).toBe("observed");
    const derived = await gw.handleCall({ name: "memory.write", arguments: { subject: "acct:42", predicate: "discount", value: "20%", space: "team:support" } });
    expect(st(String(derived._meta?.[RECEIPT_META_KEY])).consumed.factIds).toContain(plan.factId);
    const unrelated = await gw.handleCall({ name: "memory.write", arguments: { subject: "acct:77", predicate: "plan", value: "free", space: "team:support" } });
    const b = blastRadius(new Ledger(ledgerFile), loadReceipts(join(dir, "receipts")), plan.factId);
    expect(b.fact?.factId).toBe(plan.factId);
    expect(b.receipts.map((r) => r.receiptId)).toContain(String(derived._meta?.[RECEIPT_META_KEY]));
    // acct:77 was written after the agent saw the plan fact too, so by the rule it is in the radius: an upper bound, not a proof of dependence
    expect(b.derivedFacts.map((f) => `${f.subject} ${f.predicate}`).sort()).toEqual(["acct:42 discount", "acct:77 plan"]);
    expect(b.stillBelieved).toHaveLength(2);
    expect(b.receipts.map((r) => r.receiptId)).toContain(String(unrelated._meta?.[RECEIPT_META_KEY]));
    expect(b.retraction).toBeNull();
  });

  it("a retraction through the gateway cites its own receipt", async () => {
    const factId = new Ledger(ledgerFile).asOf({ subject: "acct:42", predicate: "plan" })[0]!.factId;
    const r = await gw.handleCall({ name: "memory.retract", arguments: { factId, reason: "stale CRM value" } });
    expect(r.isError).toBeFalsy();
    expect(value(r).source.receiptId).toBe(String(r._meta?.[RECEIPT_META_KEY]));
    expect(value(r).actor).toBe("support-agent");
    expect(new Ledger(ledgerFile).asOf({ subject: "acct:42", predicate: "plan" })).toEqual([]);
    const b = blastRadius(new Ledger(ledgerFile), loadReceipts(join(dir, "receipts")), factId);
    expect(b.retraction?.reason).toBe("stale CRM value");
    expect(b.stillBelieved.length).toBeGreaterThan(0);
  });
});

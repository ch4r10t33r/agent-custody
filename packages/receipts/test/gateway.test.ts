import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { loadPublicKey } from "../src/crypto.ts";
import { createGateway, RECEIPT_META_KEY, type Gateway } from "../src/gateway.ts";
import type { ReceiptBundle, ReceiptStatement } from "../src/receipt.ts";
import { formatReport, verifyBundle, type VerifyOptions } from "../src/verify.ts";
import { buildFixture, type Fixture } from "../scripts/fixture.ts";

let fx: Fixture;
let gw: Gateway;
let opts: VerifyOptions;

const decode = (b: ReceiptBundle) => JSON.parse(Buffer.from(b.envelope.payload, "base64").toString()) as ReceiptStatement;
const bundleFor = (id: string) => JSON.parse(readFileSync(join(fx.receiptsDir, `${id}.json`), "utf8")) as ReceiptBundle;
const failing = (r: ReturnType<typeof verifyBundle>) => r.checks.filter((c) => !c.ok).map((c) => c.name);

beforeAll(async () => {
  fx = buildFixture(mkdtempSync(join(tmpdir(), "agent-custody-")));
  gw = await createGateway(loadConfig(fx.configFile));
  opts = { issuerKeys: [loadPublicKey(fx.gatewayPub)], principalKeys: [loadPublicKey(fx.principalPub)], logFile: fx.logFile };
}, 30_000);
afterAll(async () => gw?.close());

describe("gateway", () => {
  it("an optional fact lookup whose call argument is absent is skipped, and a required one denies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-custody-optional-"));
    const f = buildFixture(dir);
    const cfg = JSON.parse(readFileSync(f.configFile, "utf8"));
    cfg.facts = [
      { name: "maybe", tool: "customer.lookup", args: { customer_id: "$args.related_customer" }, forTools: ["customer.lookup"], optional: true },
      { name: "must", tool: "customer.lookup", args: { customer_id: "$args.other" }, forTools: ["stripe.refund"] },
    ];
    writeFileSync(f.configFile, JSON.stringify(cfg));
    const g = await createGateway(loadConfig(f.configFile));
    try {
      const ok = await g.handleCall({ name: "customer.lookup", arguments: { customer_id: "cust_123" } });
      expect(ok.isError).toBeFalsy();
      expect(decode(JSON.parse(readFileSync(join(f.receiptsDir, `${String(ok._meta?.[RECEIPT_META_KEY])}.json`), "utf8"))).predicate.facts).toEqual({});
      const denied = await g.handleCall({ name: "stripe.refund", arguments: { customer_id: "cust_123", amount: 1 } });
      expect(denied.isError).toBe(true);
      expect((denied.content[0] as any).text).toMatch(/needs call argument "other"/);
    } finally {
      await g.close();
    }
  });

  it("several upstreams behind one grant: tools are routed by owner, and two upstreams offering the same tool is refused at startup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-custody-multi-"));
    const f = buildFixture(dir);
    const cfg = JSON.parse(readFileSync(f.configFile, "utf8"));
    const stripe = cfg.upstream;
    delete cfg.upstream;
    cfg.upstreams = [{ name: "stripe", ...stripe }, { name: "stripe-again", ...stripe }];
    writeFileSync(f.configFile, JSON.stringify(cfg));
    await expect(createGateway(loadConfig(f.configFile))).rejects.toThrow(/offered by both upstream "stripe" and upstream "stripe-again"/);
    cfg.upstreams = [{ name: "stripe", ...stripe }, { name: "echo", command: process.execPath, args: ["--import", "tsx", resolve(import.meta.dirname, "..", "scripts", "fake-echo.ts")] }];
    writeFileSync(f.configFile, JSON.stringify(cfg));
    const g = await createGateway(loadConfig(f.configFile));
    try {
      expect((await g.listTools()).map((t) => t.name).sort()).toEqual(["customer.lookup", "stripe.refund"]);
      const r = await g.handleCall({ name: "customer.lookup", arguments: { customer_id: "cust_123" } });
      expect(r.isError).toBeFalsy();
      expect(decode(JSON.parse(readFileSync(join(f.receiptsDir, `${String(r._meta?.[RECEIPT_META_KEY])}.json`), "utf8"))).predicate.tool).toEqual({ name: "customer.lookup", provenance: "observed", upstream: "stripe" });
    } finally {
      await g.close();
    }
  });

  it("only advertises tools inside the delegated scope", async () => {
    expect((await gw.listTools()).map((t) => t.name).sort()).toEqual(["customer.lookup", "stripe.refund"]);
  });

  it("executes an in-policy refund and produces a fully verifiable receipt", async () => {
    const r = await gw.handleCall({ name: "stripe.refund", arguments: { customer_id: "cust_123", amount: 50000 }, _meta: { "agent-custody/model": "m1" } });
    expect(r.isError).toBeFalsy();
    const bundle = bundleFor(String(r._meta?.[RECEIPT_META_KEY]));
    const st = decode(bundle);
    expect(st.predicate.execution.status).toBe("executed");
    expect(st.predicate.facts.customer?.value).toMatchObject({ id: "cust_123", verified: true });
    expect(st.predicate.facts.customer?.provenance).toBe("observed");
    expect(st.predicate.request.provenance).toBe("claimed");
    expect(st.predicate.model).toEqual({ id: "m1", provenance: "claimed" });
    expect(st.predicate.issuer.kind).toBe("gateway");
    expect(st.predicate.consumed).toEqual({ factIds: [], provenance: "observed" });
    expect((st.predicate.execution as any).upstream?.envelope?.payloadType).toBe("application/vnd.agent-custody.upstream+json");
    const attested = verifyBundle(bundle, { ...opts, upstreamKeys: [loadPublicKey(fx.upstreamPub)] });
    expect(attested.checks.find((c) => c.name === "upstream signature (upstream key)")?.ok).toBe(true);
    expect(formatReport(attested)).toMatch(/execution\s+attested\s+executed \(signed by upstream/);
    const wrongKey = verifyBundle(bundle, { ...opts, upstreamKeys: [loadPublicKey(fx.principalPub)] });
    expect(wrongKey.checks.find((c) => c.name === "upstream signature (upstream key)")?.ok).toBe(false);
    expect(formatReport(verifyBundle(bundle, opts))).toMatch(/carries an upstream signature/);
    const v = verifyBundle(bundle, opts);
    expect(failing(v)).toEqual([]);
    expect(v.checks.length).toBeGreaterThanOrEqual(12);
  });

  it("denies an over-limit refund but still issues a verifiable denial receipt", async () => {
    const r = await gw.handleCall({ name: "stripe.refund", arguments: { customer_id: "cust_123", amount: 500000 } });
    expect(r.isError).toBe(true);
    const bundle = bundleFor(String(r._meta?.[RECEIPT_META_KEY]));
    expect(decode(bundle).predicate.execution.status).toBe("denied");
    expect(failing(verifyBundle(bundle, opts))).toEqual([]);
  });

  it("denies a refund to an unverified customer using the gateway's own lookup, not the agent's word", async () => {
    const r = await gw.handleCall({ name: "stripe.refund", arguments: { customer_id: "cust_999", amount: 100, verified: true } });
    expect(r.isError).toBe(true);
    const st = decode(bundleFor(String(r._meta?.[RECEIPT_META_KEY])));
    expect(st.predicate.facts.customer?.value).toMatchObject({ verified: false });
    expect(st.predicate.policy?.decision).toBe("deny");
  });

  it("denies a tool outside the delegated scope before consulting policy", async () => {
    const r = await gw.handleCall({ name: "stripe.payout", arguments: { amount: 100 } });
    expect(r.isError).toBe(true);
    const st = decode(bundleFor(String(r._meta?.[RECEIPT_META_KEY])));
    expect(st.predicate.policy?.errors[0]).toMatch(/not in the delegation scopes/);
    expect(st.predicate.facts).toEqual({});
  });

  it("denies when the fact lookup itself fails, and records why", async () => {
    const r = await gw.handleCall({ name: "stripe.refund", arguments: { customer_id: "cust_404", amount: 100 } });
    expect(r.isError).toBe(true);
    const st = decode(bundleFor(String(r._meta?.[RECEIPT_META_KEY])));
    expect(st.predicate.execution.status).toBe("denied");
    expect(st.predicate.policy?.errors[0]).toMatch(/no such customer/);
  });

  it("verification fails on a tampered receipt and on a substituted log", async () => {
    const r = await gw.handleCall({ name: "stripe.refund", arguments: { customer_id: "cust_123", amount: 1000 } });
    const bundle = bundleFor(String(r._meta?.[RECEIPT_META_KEY]));

    const st = decode(bundle);
    st.predicate.request.args.amount = 1;
    const tampered = { ...bundle, envelope: { ...bundle.envelope, payload: Buffer.from(JSON.stringify(st)).toString("base64") } };
    expect(failing(verifyBundle(tampered, opts))).toEqual(["receipt signature (issuer key)"]);

    const otherLog = buildFixture(mkdtempSync(join(tmpdir(), "agent-custody-other-"))).logFile;
    const other = await createGateway(loadConfig(join(otherLog, "..", "gateway.json")));
    await other.handleCall({ name: "customer.lookup", arguments: { customer_id: "cust_123" } });
    await other.close();
    expect(failing(verifyBundle(bundle, { ...opts, logFile: otherLog }))).toEqual(["log file root matches tree head"]);
  }, 30_000);
});

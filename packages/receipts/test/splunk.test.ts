// The Splunk export is a copy for the security team's index, never the proof: one event per receipt with the
// receipt id and log position on it, sent with the HEC token from the environment, and a collector that refuses or
// is gone costs a warning, never the receipt. With both exporters configured each is told independently.
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, loadSdkConfig } from "../src/config.ts";
import { createGateway, RECEIPT_META_KEY } from "../src/gateway.ts";
import { openExporter } from "../src/otel.ts";
import { splunkExporter } from "../src/splunk.ts";
import { createSdkIssuer } from "../src/sdk/index.ts";
import { buildFixture, buildSdkFixture } from "../scripts/fixture.ts";

function hec(status = 200): Promise<{ server: Server; url: string; received: { path: string; auth: string | undefined; body: any }[] }> {
  const received: { path: string; auth: string | undefined; body: any }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ path: req.url!, auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(status, { "content-type": "application/json" });
      res.end('{"text":"Success","code":0}');
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, received })));
}

describe("Splunk HEC export", () => {
  it("the gateway posts one event per receipt to /services/collector/event with the token, index, sourcetype, and the receipt's fields", async () => {
    const c = await hec();
    process.env.TEST_HEC_TOKEN = "hec-secret";
    const fx = buildFixture(mkdtempSync(join(tmpdir(), "agent-custody-splunk-")));
    const cfg = JSON.parse(readFileSync(fx.configFile, "utf8"));
    cfg.splunk = { url: c.url, tokenEnv: "TEST_HEC_TOKEN", index: "agents", host: "gw-1" };
    cfg.precommit = ["stripe.refund"];
    writeFileSync(fx.configFile, JSON.stringify(cfg));
    const gw = await createGateway(loadConfig(fx.configFile));
    try {
      const ok = await gw.handleCall({ name: "stripe.refund", arguments: { customer_id: "cust_123", amount: 2500 } });
      const denied = await gw.handleCall({ name: "stripe.refund", arguments: { customer_id: "cust_123", amount: 5_000_000 } });
      const ids = [ok, denied].map((r) => String(r._meta?.[RECEIPT_META_KEY]));
      expect(c.received.map((r) => r.path)).toEqual(["/services/collector/event", "/services/collector/event"]);
      expect(c.received[0]!.auth).toBe("Splunk hec-secret");
      const [first, second] = c.received.map((r) => r.body);
      expect(first).toMatchObject({ index: "agents", host: "gw-1", source: "agent-custody", sourcetype: "agent-custody:receipt" });
      expect(typeof first.time).toBe("number");
      expect(first.event).toMatchObject({ receipt_id: ids[0], tool: "stripe.refund", status: "executed", policy_decision: "allow", issuer_kind: "gateway", agent: "support-agent", principal: "user_456", log_leaf_index: 1, authorization_leaf_index: 0 });
      expect(second.event).toMatchObject({ receipt_id: ids[1], status: "denied", policy_decision: "deny", authorization_leaf_index: null });
      expect(second.event.reason).toMatch(/./);
    } finally {
      await gw.close();
      c.server.close();
    }
  });

  it("the SDK issuer exports too; a collector that refuses or is unreachable costs a warning, never the receipt; both exporters run when both are configured", async () => {
    const refusing = await hec(503);
    const otlp = await hec();
    process.env.TEST_HEC_TOKEN = "hec-secret";
    const dir = mkdtempSync(join(tmpdir(), "agent-custody-splunk-sdk-"));
    const sfx = buildSdkFixture(dir, undefined, "splunk-test");
    const cfg = JSON.parse(readFileSync(sfx.configFile, "utf8"));
    cfg.splunk = { url: refusing.url, tokenEnv: "TEST_HEC_TOKEN" };
    cfg.otel = { url: otlp.url };
    writeFileSync(sfx.configFile, JSON.stringify(cfg));
    const warnings: string[] = [];
    const orig = console.error;
    console.error = (m: string) => warnings.push(String(m));
    try {
      const issuer = createSdkIssuer(loadSdkConfig(sfx.configFile));
      const bundle = await issuer.record({ tool: "crm.lookup", args: { id: 1 } }, { status: "executed", result: { plan: "pro" } });
      expect(bundle.inclusion.leafIndex).toBe(0);
      expect(refusing.received).toHaveLength(1);
      expect(otlp.received.map((r) => r.path)).toEqual(["/v1/traces"]);
      expect(warnings.join("\n")).toMatch(/splunk export of receipt .* refused by .*: 503/);
      refusing.server.close();
      await new Promise((r) => setTimeout(r, 50));
      const again = await issuer.record({ tool: "crm.lookup", args: { id: 2 } }, { status: "error", error: "x" });
      expect(again.inclusion.leafIndex).toBe(1);
      expect(warnings.join("\n")).toMatch(/splunk export of receipt .* failed/);
      expect(otlp.received).toHaveLength(2);
    } finally {
      console.error = orig;
      otlp.server.close();
    }
  });

  it("a missing token variable fails at startup, and a config with neither block opens no exporter", () => {
    expect(() => splunkExporter({ url: "http://127.0.0.1:1", tokenEnv: "NOT_SET_ANYWHERE_HEC" })).toThrow(/NOT_SET_ANYWHERE_HEC/);
    expect(openExporter({})).toBeUndefined();
  });
});

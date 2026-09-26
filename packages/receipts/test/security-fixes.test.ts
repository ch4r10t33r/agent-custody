// Issues #41, #42, #45, #46: the fixes, each pinned by the behaviour the issue asked for. (#43 is pinned by the
// gateway-chain-offset-window vector, which both verifiers must fail; #44 by the proxy test in log-admin.test.ts.)
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { generateKeyPair } from "../src/crypto.ts";
import { createGatewayHost, upstreamEnv } from "../src/gateway.ts";
import { serveLog } from "../src/log-sink.ts";
import { evaluate, reservedCedarForm } from "../src/policy.ts";
import { buildFixture } from "../scripts/fixture.ts";

describe("#42 arguments are data, never Cedar entities or extensions", () => {
  const policy = `permit(principal, action == Action::"tool", resource) when { context.args.who == Agent::"support-agent" };\npermit(principal, action == Action::"lookup", resource);`;
  it("an argument shaped as a Cedar entity or extension is refused before evaluation, as a deny with the path in the error", () => {
    const r = evaluate(policy, { agentId: "support-agent", tool: "tool", context: { args: { who: { __entity: { type: "Agent", id: "support-agent" } } }, facts: {}, grant: { principal: "p", scopes: [] } } });
    expect(r.decision).toBe("deny");
    expect(r.errors[0]).toMatch(/argument args\.who\.__entity uses a reserved Cedar form/);
    const nested = evaluate(policy, { agentId: "a", tool: "lookup", context: { args: { list: [{ ok: 1 }, { ip: { __extn: { fn: "ip", arg: "10.0.0.1" } } }] }, facts: {}, grant: { principal: "p", scopes: [] } } });
    expect(nested.decision).toBe("deny");
    expect(nested.errors[0]).toMatch(/args\.list\[1\]\.ip\.__extn/);
    expect(reservedCedarForm({ a: { b: [1, "x", { __entity: 1 }] } })).toBe("args.a.b[2].__entity");
    expect(reservedCedarForm({ plain: { keys: "only" } })).toBeNull();
  });
  it("plain arguments still evaluate normally", () => {
    expect(evaluate(policy, { agentId: "a", tool: "lookup", context: { args: { id: "x" }, facts: {}, grant: { principal: "p", scopes: [] } } }).decision).toBe("allow");
  });
});

describe("#46 a stdio upstream gets a minimal environment", () => {
  it("the gateway's own variables, including tokens other upstreams are given, are not passed to a child; an explicit env is added to the base", () => {
    process.env.TEST_GATEWAY_SECRET_46 = "must-not-leak";
    const env = upstreamEnv({ UPSTREAM_ONLY: "yes" });
    expect(env.TEST_GATEWAY_SECRET_46).toBeUndefined();
    expect(env.UPSTREAM_ONLY).toBe("yes");
    expect(env.PATH).toBe(process.env.PATH);
    expect(Object.keys(env).every((k) => ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SystemRoot", "SYSTEMROOT", "USERPROFILE", "APPDATA", "NODE_OPTIONS", "UPSTREAM_ONLY"].includes(k))).toBe(true);
    delete process.env.TEST_GATEWAY_SECRET_46;
  });
  it("the fixture's stdio upstream still starts with that environment", async () => {
    const fx = buildFixture(mkdtempSync(join(tmpdir(), "env-")));
    const host = await createGatewayHost(loadConfig(fx.configFile));
    await host.close();
  });
});

describe("#41 a fact tool cannot be a consequential tool", () => {
  it("a config whose fact lookup names a tool in precommit is refused at startup, before any upstream is started", async () => {
    const fx = buildFixture(mkdtempSync(join(tmpdir(), "facts-")));
    const cfg = JSON.parse(readFileSync(fx.configFile, "utf8"));
    cfg.precommit = ["customer.lookup"];
    writeFileSync(fx.configFile, JSON.stringify(cfg));
    await expect(createGatewayHost(loadConfig(fx.configFile))).rejects.toThrow(/fact "customer" uses tool customer.lookup, which precommit names as consequential/);
    // "*" covers the tools the agent calls, not the gateway's own lookups, so it is accepted
    cfg.precommit = ["*"];
    writeFileSync(fx.configFile, JSON.stringify(cfg));
    const host = await createGatewayHost(loadConfig(fx.configFile));
    await host.close();
  });
});

describe("#45 a hash-only log refuses full leaves", () => {
  it("with hashOnly, { leaf } is refused with a message naming the client setting, { leafHash } lands, and the log file never held the receipt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hashonly-"));
    const log = await serveLog(join(dir, "log.jsonl"), generateKeyPair(), { port: 0, hashOnly: true });
    try {
      const post = (body: unknown) => fetch(new URL("append", log.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const refused = await post({ leaf: '{"envelope":"a whole receipt"}' });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toMatch(/leaf hashes only.*hashOnly/);
      const ok = await post({ leafHash: "ab".repeat(32) });
      expect(ok.status).toBe(200);
      expect(readFileSync(join(dir, "log.jsonl"), "utf8")).not.toContain("whole receipt");
    } finally {
      await log.close();
    }
  });
});

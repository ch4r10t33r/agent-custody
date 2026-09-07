// Provider-native signatures: a Stripe webhook or a GitHub delivery attached by the upstream, checked with the shared
// secret, bound to the object the receipt's result names. Weaker than a key, and labelled as such.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { loadPublicKey } from "../src/crypto.ts";
import { createGateway, RECEIPT_META_KEY } from "../src/gateway.ts";
import { checkProvider, githubSignature, stripeSignature, type ProviderAttestation } from "../src/upstream.ts";
import { formatReport, verifyBundle } from "../src/verify.ts";
import { buildFixture } from "../scripts/fixture.ts";

const now = () => new Date().toISOString();

describe("provider-native signatures", () => {
  it("stripe: the HMAC, the timestamp tolerance, and the binding to the result all have to hold", () => {
    const body = JSON.stringify({ id: "evt_1", data: { object: { id: "re_abc", amount: 500 } } });
    const t = Math.floor(Date.now() / 1000);
    const att: ProviderAttestation = { provider: "stripe-webhook", rawBody: body, signature: stripeSignature(body, "whsec_1", t), bind: "data.object.id" };
    const result = { content: [{ type: "text", text: JSON.stringify({ refund_id: "re_abc", status: "succeeded" }) }] };
    expect(checkProvider(att, { stripe: "whsec_1" }, { timestamp: now(), result }).ok).toBe(true);
    expect(checkProvider(att, { stripe: "whsec_2" }, { timestamp: now(), result })).toMatchObject({ ok: false, error: /does not verify/ });
    expect(checkProvider(att, { github: "x" }, { timestamp: now(), result })).toMatchObject({ ok: false, error: /no Stripe secret/ });
    expect(checkProvider(att, { stripe: "whsec_1" }, { timestamp: new Date(Date.now() - 3600_000).toISOString(), result })).toMatchObject({ ok: false, error: /beyond tolerance/ });
    expect(checkProvider(att, { stripe: "whsec_1" }, { timestamp: now(), result: { content: [{ type: "text", text: JSON.stringify({ refund_id: "re_other" }) }] } })).toMatchObject({ ok: false, error: /does not appear in the receipt/ });
    expect(checkProvider({ ...att, bind: "data.object.missing" }, { stripe: "whsec_1" }, { timestamp: now(), result })).toMatchObject({ ok: false, error: /no value at/ });
  });

  it("github: sha256= over the raw body, bound on a field", () => {
    const body = JSON.stringify({ action: "closed", pull_request: { number: 42, merged: true, merge_commit_sha: "abc123" } });
    const att: ProviderAttestation = { provider: "github-delivery", rawBody: body, signature: githubSignature(body, "gh_secret"), bind: "pull_request.merge_commit_sha", deliveryId: "d-1" };
    const result = { content: [{ type: "text", text: JSON.stringify({ merged: true, sha: "abc123" }) }] };
    expect(checkProvider(att, { github: "gh_secret" }, { timestamp: now(), result }).ok).toBe(true);
    expect(checkProvider({ ...att, signature: "sha256=00" }, { github: "gh_secret" }, { timestamp: now(), result })).toMatchObject({ ok: false, error: /does not verify/ });
  });

  it("through the gateway: the fake Stripe attaches its webhook, the receipt embeds it, and the verifier attests with the secret", async () => {
    const fx = buildFixture(mkdtempSync(join(tmpdir(), "providers-")));
    const cfg = JSON.parse(readFileSync(fx.configFile, "utf8"));
    cfg.upstream.args = [...cfg.upstream.args.filter((a: string, i: number, all: string[]) => a !== "--key" && all[i - 1] !== "--key"), "--webhook-secret", "whsec_test"];
    writeFileSync(fx.configFile, JSON.stringify(cfg));
    const gw = await createGateway(loadConfig(fx.configFile));
    try {
      const r = await gw.handleCall({ name: "stripe.refund", arguments: { customer_id: "cust_123", amount: 50000 } });
      expect(r.isError).toBeFalsy();
      const bundle = JSON.parse(readFileSync(join(fx.receiptsDir, `${String(r._meta?.[RECEIPT_META_KEY])}.json`), "utf8"));
      const keys = { issuerKeys: [loadPublicKey(fx.gatewayPub)], principalKeys: [loadPublicKey(fx.principalPub)], logFile: fx.logFile };
      const plain = verifyBundle(bundle, keys);
      expect(plain.ok).toBe(true);
      expect(formatReport(plain)).toMatch(/carries a provider delivery/);
      const withSecret = verifyBundle(bundle, { ...keys, providerSecrets: { stripe: "whsec_test" } });
      expect(withSecret.ok).toBe(true);
      expect(withSecret.checks.find((c) => c.name === "upstream signature (provider secret)")?.detail).toMatch(/shared secret \(stripe-webhook, bound on data\.object\.id\)/);
      expect(formatReport(withSecret)).toMatch(/execution\s+attested \(shared secret\)/);
      const wrong = verifyBundle(bundle, { ...keys, providerSecrets: { stripe: "whsec_wrong" } });
      expect(wrong.ok).toBe(false);
      expect(wrong.checks.find((c) => c.name === "upstream signature (provider secret)")?.ok).toBe(false);
    } finally {
      await gw.close();
    }
  });
});

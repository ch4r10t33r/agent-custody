// Pruning exists so retention can reach the receipt log without breaking a single proof.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSdkConfig } from "../src/config.ts";
import { loadPublicKey } from "../src/crypto.ts";
import { MerkleLog } from "../src/log.ts";
import { pruneLog } from "../src/retention.ts";
import { createSdkIssuer } from "../src/sdk/index.ts";
import { auditExtends, verifyBundle } from "../src/verify.ts";
import { buildSdkFixture } from "../scripts/fixture.ts";

describe("receipt-log retention", () => {
  it("pruned leaves keep their hash: later receipts still verify against the log, audits still pass, and the content is gone", async () => {
    const fx = buildSdkFixture(mkdtempSync(join(tmpdir(), "prune-")));
    const issuer = createSdkIssuer(loadSdkConfig(fx.configFile));
    const early = await issuer.record({ tool: "customer.lookup", args: { id: "c1", secret: "SSN-123" } }, { status: "executed", result: { name: "Alex" } });
    const cutoff = new Date(Date.now() + 5).toISOString();
    await new Promise((r) => setTimeout(r, 10));
    const late = await issuer.record({ tool: "customer.lookup", args: { id: "c2" } }, { status: "executed", result: { name: "Sam" } });
    const rootBefore = new MerkleLog(fx.logFile).root();
    expect(readFileSync(fx.logFile, "utf8")).not.toContain("SSN-123"); // the leaf is base64; check via the decoded receipt instead
    const r = pruneLog(fx.logFile, cutoff, fx.receiptsDir);
    expect(r.pruned.map((p) => p.leafIndex)).toEqual([0]);
    expect(r.kept).toBe(1);
    expect(r.bundlesRemoved).toBe(1);
    expect(existsSync(join(fx.receiptsDir, `${JSON.parse(Buffer.from(early.envelope.payload, "base64").toString()).predicate.receiptId}.json`))).toBe(false);
    const lines = readFileSync(fx.logFile, "utf8").trim().split("\n");
    expect(JSON.parse(lines[0]!)).toHaveProperty("pruned");
    expect(new MerkleLog(fx.logFile).root()).toBe(rootBefore);
    const keys = { issuerKeys: [loadPublicKey(fx.appPub)], principalKeys: [] };
    expect(verifyBundle(late, { ...keys, logFile: fx.logFile }).ok).toBe(true);
    // a holder of the pruned receipt's bundle can still prove it was in the log
    expect(verifyBundle(early, { ...keys, logFile: fx.logFile }).ok).toBe(true);
    expect(auditExtends(early.treeHead, late.treeHead, new MerkleLog(fx.logFile).consistencyProof(1, 2), keys.issuerKeys).ok).toBe(true);
    // pruning again with the same cutoff is a no-op: pruned leaves stay pruned, later leaves stay whole
    expect(pruneLog(fx.logFile, cutoff, fx.receiptsDir).pruned).toEqual([]);
  });
});

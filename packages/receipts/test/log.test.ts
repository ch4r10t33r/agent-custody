import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inclusionProof, leafHash, MerkleLog, rootOf, verifyInclusion } from "../src/log.ts";

describe("Merkle log", () => {
  it("proves inclusion of every leaf for every tree size up to 10", () => {
    for (let n = 1; n <= 10; n++) {
      const leaves = Array.from({ length: n }, (_, i) => leafHash(`leaf-${i}`));
      const root = rootOf(leaves);
      for (let i = 0; i < n; i++) {
        expect(verifyInclusion(leaves[i]!, inclusionProof(leaves, i), root), `n=${n} i=${i}`).toBe(true);
      }
    }
  });

  it("rejects a proof for altered leaf content, a wrong index, or a wrong root", () => {
    const leaves = Array.from({ length: 7 }, (_, i) => leafHash(`leaf-${i}`));
    const root = rootOf(leaves);
    const proof = inclusionProof(leaves, 3);
    expect(verifyInclusion(leafHash("leaf-3-edited"), proof, root)).toBe(false);
    expect(verifyInclusion(leaves[3]!, { ...proof, leafIndex: 4 }, root)).toBe(false);
    expect(verifyInclusion(leaves[3]!, proof, rootOf(leaves.slice(0, 6)))).toBe(false);
  });

  it("matches RFC 6962 test vector for the empty tree", () => {
    expect(rootOf([])).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("persists to JSONL so an auditor can recompute the root at any earlier size", () => {
    const dir = mkdtempSync(join(tmpdir(), "mlog-"));
    const file = join(dir, "log.jsonl");
    const log = new MerkleLog(file);
    const entries = ["a", "b", "c", "d", "e"].map((s) => log.append(JSON.stringify({ s })));
    const reopened = new MerkleLog(file);
    expect(reopened.size).toBe(5);
    for (const e of entries) {
      expect(MerkleLog.rootFromFile(file, e.treeSize)).toBe(e.rootHash);
      expect(verifyInclusion(leafHash(JSON.stringify({ s: "abcde"[e.leafIndex] })), e, e.rootHash)).toBe(true);
    }
  });

  it("detects a rewritten history: an edited log line changes the root", () => {
    const dir = mkdtempSync(join(tmpdir(), "mlog-"));
    const file = join(dir, "log.jsonl");
    const log = new MerkleLog(file);
    log.append("one");
    const second = log.append("two");
    writeFileSync(file, JSON.stringify("one") + "\n" + JSON.stringify("TWO") + "\n");
    expect(MerkleLog.rootFromFile(file, 2)).not.toBe(second.rootHash);
  });
});

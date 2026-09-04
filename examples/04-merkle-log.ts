// Aspect: the transparency log. Source: src/log.ts
// Run:    npx tsx examples/04-merkle-log.ts
//
// Every receipt is appended to a Merkle log (RFC 6962 hashing). The receipt bundle carries an inclusion proof and a
// signed tree head. An auditor holding a copy of the log file can recompute the root and detect any rewrite.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { leafHash, MerkleLog, verifyInclusion } from "../src/log.ts";
import { out, step } from "./_out.ts";

const dir = out("04-log");
const file = join(dir, "log.jsonl");

step(1, "append five leaves; each append returns the proof for that leaf against the new root");
const log = new MerkleLog(file);
const entries = ["receipt-a", "receipt-b", "receipt-c", "receipt-d", "receipt-e"].map((leaf) => ({ leaf, ...log.append(leaf) }));
for (const e of entries) console.log(`   leaf ${e.leafIndex} of ${e.treeSize}: root ${e.rootHash.slice(0, 16)}… proof hashes ${e.hashes.length}`);

step(2, "verify inclusion of leaf 2 using only the leaf, the proof, and the root it was issued against");
const c = entries[2]!;
console.log("   included:", verifyInclusion(leafHash(c.leaf), c, c.rootHash));

step(3, "the log file is one JSON string per line; anyone can recompute the root at any earlier size");
console.log("   lines:", readFileSync(file, "utf8").trim().split("\n").length);
console.log("   root at size 3 recomputed from file matches the tree head issued at size 3:", MerkleLog.rootFromFile(file, 3) === c.rootHash);

step(4, "an operator edits line 2 after the fact");
const lines = readFileSync(file, "utf8").trim().split("\n");
lines[1] = JSON.stringify("receipt-B-edited");
writeFileSync(file, lines.join("\n") + "\n");
console.log("   root at size 3 still matches:", MerkleLog.rootFromFile(file, 3) === c.rootHash);

step(5, "a wrong index or a wrong root also fails");
console.log("   wrong index:", verifyInclusion(leafHash(c.leaf), { ...c, leafIndex: 3 }, c.rootHash));
console.log("   wrong root: ", verifyInclusion(leafHash(c.leaf), c, entries[4]!.rootHash));

console.log("\nOK");

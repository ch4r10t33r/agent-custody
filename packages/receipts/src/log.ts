// Append-only Merkle log with RFC 6962 / RFC 9162 hashing and inclusion proofs.
// Leaves are stored as JSONL so anyone holding the file can recompute the root.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface InclusionProof {
  leafIndex: number;
  treeSize: number;
  hashes: string[]; // hex, leaf-to-root order
}

const h = (...parts: Buffer[]) => {
  const c = createHash("sha256");
  for (const p of parts) c.update(p);
  return c.digest();
};

export function leafHash(data: string): Buffer {
  return h(Buffer.from([0x00]), Buffer.from(data));
}

const nodeHash = (l: Buffer, r: Buffer) => h(Buffer.from([0x01]), l, r);

/** largest power of two strictly less than n (n >= 2) */
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

function mth(leaves: Buffer[], lo: number, hi: number): Buffer {
  const n = hi - lo;
  if (n === 0) return createHash("sha256").digest();
  if (n === 1) return leaves[lo]!;
  const k = split(n);
  return nodeHash(mth(leaves, lo, lo + k), mth(leaves, lo + k, hi));
}

function path(m: number, leaves: Buffer[], lo: number, hi: number): Buffer[] {
  const n = hi - lo;
  if (n <= 1) return [];
  const k = split(n);
  return m < k
    ? [...path(m, leaves, lo, lo + k), mth(leaves, lo + k, hi)]
    : [...path(m - k, leaves, lo + k, hi), mth(leaves, lo, lo + k)];
}

/** RFC 9162 section 2.1.4.1: SUBPROOF(m, D[n], b). */
function subproof(m: number, leaves: Buffer[], lo: number, hi: number, b: boolean): Buffer[] {
  const n = hi - lo;
  if (m === n) return b ? [] : [mth(leaves, lo, hi)];
  const k = split(n);
  return m <= k
    ? [...subproof(m, leaves, lo, lo + k, b), mth(leaves, lo + k, hi)]
    : [...subproof(m - k, leaves, lo + k, hi, false), mth(leaves, lo, lo + k)];
}

/** Proof that the tree of size newSize extends the tree of size oldSize. Empty when oldSize is 0 or equal to newSize. */
export function consistencyProof(leafHashes: Buffer[], oldSize: number, newSize = leafHashes.length): string[] {
  if (oldSize < 0 || oldSize > newSize || newSize > leafHashes.length) throw new Error("sizes out of range");
  if (oldSize === 0 || oldSize === newSize) return [];
  return subproof(oldSize, leafHashes, 0, newSize, true).map((b) => b.toString("hex"));
}

/** RFC 9162 section 2.1.4.2. Pure: needs only the two sizes, the two roots, and the proof. */
export function verifyConsistency(oldSize: number, oldRootHex: string, newSize: number, newRootHex: string, proofHex: string[]): boolean {
  if (oldSize < 0 || oldSize > newSize) return false;
  if (oldSize === newSize) return proofHex.length === 0 && oldRootHex === newRootHex;
  if (oldSize === 0) return proofHex.length === 0;
  if (proofHex.length === 0) return false;
  const proof = proofHex.map((x) => Buffer.from(x, "hex"));
  if ((oldSize & (oldSize - 1)) === 0) proof.unshift(Buffer.from(oldRootHex, "hex"));
  let fn = oldSize - 1;
  let sn = newSize - 1;
  while (fn % 2 === 1) {
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  let fr = proof[0]!;
  let sr = proof[0]!;
  for (const c of proof.slice(1)) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      while (fn % 2 === 0 && fn !== 0) {
        fn = Math.floor(fn / 2);
        sn = Math.floor(sn / 2);
      }
    } else {
      sr = nodeHash(sr, c);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && fr.toString("hex") === oldRootHex && sr.toString("hex") === newRootHex;
}

export function rootOf(leafHashes: Buffer[], size = leafHashes.length): string {
  return mth(leafHashes, 0, size).toString("hex");
}

export function inclusionProof(leafHashes: Buffer[], leafIndex: number, treeSize = leafHashes.length): InclusionProof {
  if (leafIndex < 0 || leafIndex >= treeSize || treeSize > leafHashes.length) throw new Error("index out of range");
  return { leafIndex, treeSize, hashes: path(leafIndex, leafHashes, 0, treeSize).map((b) => b.toString("hex")) };
}

/** RFC 9162 section 2.1.3.2 verification. Pure function: needs only the leaf hash, proof and claimed root. */
export function verifyInclusion(leaf: Buffer, proof: InclusionProof, rootHex: string): boolean {
  let fn = proof.leafIndex;
  let sn = proof.treeSize - 1;
  if (fn < 0 || sn < 0 || fn > sn) return false;
  let r = leaf;
  for (const hex of proof.hashes) {
    if (sn === 0) return false;
    const p = Buffer.from(hex, "hex");
    if (fn % 2 === 1 || fn === sn) {
      r = nodeHash(p, r);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else {
      r = nodeHash(r, p);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && r.toString("hex") === rootHex;
}

export class MerkleLog {
  private hashes: Buffer[] = [];
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (line.trim()) this.hashes.push(leafHash(JSON.parse(line)));
      }
    } else {
      mkdirSync(dirname(file), { recursive: true });
    }
  }

  get size(): number {
    return this.hashes.length;
  }

  /** Appends a leaf (an opaque string, typically a canonical JSON envelope). Returns its proof against the new root. */
  append(leaf: string): InclusionProof & { rootHash: string } {
    appendFileSync(this.file, JSON.stringify(leaf) + "\n");
    this.hashes.push(leafHash(leaf));
    const treeSize = this.hashes.length;
    return { ...inclusionProof(this.hashes, treeSize - 1, treeSize), rootHash: rootOf(this.hashes, treeSize) };
  }

  root(size = this.size): string {
    return rootOf(this.hashes, size);
  }

  /** Proof that this log at newSize extends its own earlier state at oldSize. */
  consistencyProof(oldSize: number, newSize = this.size): string[] {
    return consistencyProof(this.hashes, oldSize, newSize);
  }

  /** Reads a log file and returns the root at the given size, for auditors holding a copy of the log. */
  static rootFromFile(file: string, size: number): string {
    return new MerkleLog(file).root(size);
  }
}

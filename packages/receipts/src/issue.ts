// Signing, logging and writing a receipt. Shared by every producer: the gateway and the SDK.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalize, dsseSign, type KeyPair } from "./crypto.ts";
import { MerkleLog } from "./log.ts";
import { buildStatement, RECEIPT_TYPE, TREEHEAD_TYPE, type ReceiptBundle, type ReceiptPredicate } from "./receipt.ts";

export interface Issuer {
  keyid: string;
  issue(predicate: ReceiptPredicate): ReceiptBundle;
}

export function createIssuer(key: KeyPair, receiptsDir: string, logFile: string): Issuer {
  const log = new MerkleLog(logFile);
  mkdirSync(receiptsDir, { recursive: true });
  return {
    keyid: key.keyid,
    issue(predicate) {
      const envelope = dsseSign(RECEIPT_TYPE, buildStatement(predicate), key);
      const entry = log.append(canonicalize(envelope));
      const treeHead = dsseSign(TREEHEAD_TYPE, { treeSize: entry.treeSize, rootHash: entry.rootHash, timestamp: new Date().toISOString() }, key);
      const bundle: ReceiptBundle = { envelope, treeHead, inclusion: { leafIndex: entry.leafIndex, treeSize: entry.treeSize, hashes: entry.hashes } };
      writeFileSync(join(receiptsDir, `${predicate.receiptId}.json`), JSON.stringify(bundle, null, 2));
      return bundle;
    },
  };
}

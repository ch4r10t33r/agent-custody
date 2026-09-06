// Signing, logging and writing a receipt. Shared by every producer: the gateway and the SDK.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalize, dsseSign, type KeyPair } from "./crypto.ts";
import { fileLog, type LogSink } from "./log-sink.ts";
import { buildStatement, RECEIPT_TYPE, type ReceiptBundle, type ReceiptPredicate } from "./receipt.ts";

export interface Issuer {
  keyid: string;
  log: LogSink;
  /** Signs the statement, appends it to the log, writes the bundle. Rejects if the log refuses the leaf; no bundle is written then. */
  issue(predicate: ReceiptPredicate): Promise<ReceiptBundle>;
}

/** `log` is a sink, or a file path for the local log with tree heads signed by the issuer's key. */
export function createIssuer(key: KeyPair, receiptsDir: string, log: string | LogSink): Issuer {
  const sink = typeof log === "string" ? fileLog(log, key) : log;
  mkdirSync(receiptsDir, { recursive: true });
  return {
    keyid: key.keyid,
    log: sink,
    async issue(predicate) {
      const envelope = dsseSign(RECEIPT_TYPE, buildStatement(predicate), key);
      const entry = await sink.append(canonicalize(envelope));
      const bundle: ReceiptBundle = { envelope, treeHead: entry.treeHead, inclusion: entry.inclusion };
      writeFileSync(join(receiptsDir, `${predicate.receiptId}.json`), JSON.stringify(bundle, null, 2));
      return bundle;
    },
  };
}

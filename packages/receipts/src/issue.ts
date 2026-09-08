// Signing, logging and writing a receipt. Shared by every producer: the gateway and the SDK.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalize, dsseSign, type KeyPair } from "./crypto.ts";
import { fileLog, type LogSink } from "./log-sink.ts";
import type { ReceiptExporter } from "./otel.ts";
import { buildAuthorizationStatement, buildStatement, RECEIPT_TYPE, type AuthorizationBundle, type AuthorizationPredicate, type ReceiptBundle, type ReceiptPredicate } from "./receipt.ts";

export interface Issuer {
  keyid: string;
  log: LogSink;
  /** Signs the statement, appends it to the log, writes the bundle. Rejects if the log refuses the leaf; no bundle is written then. */
  issue(predicate: ReceiptPredicate): Promise<ReceiptBundle>;
  /** Signs and commits an authorization before a consequential call is forwarded. Rejects if the log refuses; the caller must then not forward. */
  authorize(predicate: AuthorizationPredicate): Promise<AuthorizationBundle>;
}

export interface IssuerOptions {
  /** told about every receipt after it is written; an exporter's failure never reaches the caller */
  exporter?: ReceiptExporter | undefined;
}

/** `log` is a sink, or a file path for the local log with tree heads signed by the issuer's key. */
export function createIssuer(key: KeyPair, receiptsDir: string, log: string | LogSink, opts: IssuerOptions = {}): Issuer {
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
      // After the evidence, not before, and awaited so a process that exits right after issuing still exports.
      if (opts.exporter) await opts.exporter.exported(predicate, bundle).catch(() => {});
      return bundle;
    },
    async authorize(predicate) {
      const envelope = dsseSign(RECEIPT_TYPE, buildAuthorizationStatement(predicate), key);
      const entry = await sink.append(canonicalize(envelope));
      const bundle: AuthorizationBundle = { envelope, treeHead: entry.treeHead, inclusion: entry.inclusion };
      // On disk in its own right: if the process dies between forwarding and the receipt, this is the evidence that the call was authorized and sent.
      writeFileSync(join(receiptsDir, `${predicate.receiptId}.authorization.json`), JSON.stringify(bundle, null, 2));
      return bundle;
    },
  };
}

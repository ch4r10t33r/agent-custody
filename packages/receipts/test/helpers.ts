import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReceiptBundle, ReceiptStatement } from "../src/receipt.ts";
import type { SdkFixture } from "../scripts/fixture.ts";

export const decode = (b: ReceiptBundle) => JSON.parse(Buffer.from(b.envelope.payload, "base64").toString()) as ReceiptStatement;

/** Every receipt in the fixture's log, oldest first, as (bundle, statement) pairs. */
export function receipts(fx: SdkFixture): { bundle: ReceiptBundle; st: ReceiptStatement }[] {
  const lines = readFileSync(fx.logFile, "utf8").trim().split("\n").filter(Boolean);
  return lines.map((line) => {
    const env = JSON.parse(JSON.parse(line)) as ReceiptBundle["envelope"];
    const id = decode({ envelope: env } as ReceiptBundle).predicate.receiptId;
    const bundle = JSON.parse(readFileSync(join(fx.receiptsDir, `${id}.json`), "utf8")) as ReceiptBundle;
    return { bundle, st: decode(bundle) };
  });
}

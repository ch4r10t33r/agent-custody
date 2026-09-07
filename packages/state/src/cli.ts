#!/usr/bin/env node
import { parseArgs } from "node:util";
import { Ledger } from "./ledger.ts";
import { createMemoryServer, serveStdio } from "./server.ts";
import { blastRadius, formatBlastRadius, loadReceipts } from "./blast.ts";

const USAGE = `agent-custody-memory <command>

  serve --ledger <ledger.jsonl> [--allow-direct]   the memory server over stdio; run it as the receipts gateway's upstream.
                                                   By default it refuses calls that did not come through the gateway.
  blast --ledger <ledger.jsonl> --receipts <dir> --fact <factId> [--json]
                                                   everything that relied on a fact: later calls, derived beliefs, and whether it was retracted
`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "serve": {
      const { values } = parseArgs({ args: rest, options: { ledger: { type: "string" }, "allow-direct": { type: "boolean", default: false } } });
      if (!values.ledger) throw new Error("serve needs --ledger");
      const ledger = new Ledger(values.ledger);
      console.error(`agent-custody-memory: ledger=${values.ledger} events=${ledger.size} ${values["allow-direct"] ? "direct calls allowed" : "gateway calls only"}`);
      await serveStdio(createMemoryServer(ledger, { requireGateway: !values["allow-direct"] }));
      return 0;
    }
    case "blast": {
      const { values } = parseArgs({ args: rest, options: { ledger: { type: "string" }, receipts: { type: "string" }, fact: { type: "string" }, json: { type: "boolean", default: false } } });
      if (!values.ledger || !values.receipts || !values.fact) throw new Error("blast needs --ledger, --receipts, and --fact");
      const b = blastRadius(new Ledger(values.ledger), loadReceipts(values.receipts), values.fact);
      console.log(values.json ? JSON.stringify(b, null, 2) : formatBlastRadius(b, values.fact));
      return b.fact ? 0 : 1;
    }
    default:
      console.error(USAGE);
      return cmd === undefined || cmd === "--help" || cmd === "-h" ? 0 : 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(`error: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  },
);

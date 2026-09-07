#!/usr/bin/env node
import { parseArgs } from "node:util";
import { Ledger } from "./ledger.ts";
import { createMemoryServer, serveStdio } from "./server.ts";

const USAGE = `agent-custody-memory <command>

  serve --ledger <ledger.jsonl> [--allow-direct]   the memory server over stdio; run it as the receipts gateway's upstream.
                                                   By default it refuses calls that did not come through the gateway.
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

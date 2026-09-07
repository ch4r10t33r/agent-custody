#!/usr/bin/env node
import { parseArgs } from "node:util";
import { Ledger } from "./ledger.ts";
import { createMemoryServer, serveStdio } from "./server.ts";
import { blastRadius, formatBlastRadius, loadReceipts } from "./blast.ts";
import { serveMemoryHttp } from "./http.ts";
import { loadPrivateKey } from "@agent-custody/receipts";

const USAGE = `agent-custody-memory <command>

  serve --ledger <ledger.jsonl> [--allow-direct] [--key <memory.key>]
                                                   the memory server over stdio; run it as the receipts gateway's upstream.
                                                   --key signs every result for its receipt, so executions verify as attested by this server.
                                                   By default it refuses calls that did not come through the gateway.
  serve --ledger <ledger.jsonl> --http [--port 8790] [--host 127.0.0.1] [--token-env NAME] [--allow-direct]
                                                   the same server shared over HTTP: several gateways, one ledger
  sweep --ledger <ledger.jsonl> --before <ISO instant> [--space <space>] --reason <text> [--actor <id>]
                                                   retention on the ledger file alone: forgets what was learned before the instant, skipping held facts.
                                                   Through the gateway, memory.sweep does the same and reaches the stores.
  blast --ledger <ledger.jsonl> --receipts <dir> --fact <factId> [--json]
                                                   everything that relied on a fact: later calls, derived beliefs, and whether it was retracted
`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "serve": {
      const { values } = parseArgs({ args: rest, options: { ledger: { type: "string" }, "allow-direct": { type: "boolean", default: false }, http: { type: "boolean", default: false }, port: { type: "string", default: "8790" }, host: { type: "string", default: "127.0.0.1" }, "token-env": { type: "string" }, key: { type: "string" } } });
      if (!values.ledger) throw new Error("serve needs --ledger");
      const ledger = new Ledger(values.ledger);
      const identity = values.key ? loadPrivateKey(values.key) : undefined;
      if (values.http) {
        const token = values["token-env"] ? process.env[values["token-env"]] : undefined;
        if (values["token-env"] && !token) throw new Error(`serve: environment variable ${values["token-env"]} is not set`);
        const running = await serveMemoryHttp(ledger, { port: Number(values.port), host: values.host, requireGateway: !values["allow-direct"], ...(token ? { tokens: [token] } : {}), ...(identity ? { identity } : {}) });
        console.error(`agent-custody-memory: ${running.url} ledger=${values.ledger} events=${ledger.size} ${token ? "bearer token required" : "open"} ${values["allow-direct"] ? "direct calls allowed" : "gateway calls only"}`);
        await new Promise<void>((resolve) => process.once("SIGINT", resolve));
        await running.close();
        return 0;
      }
      console.error(`agent-custody-memory: ledger=${values.ledger} events=${ledger.size} ${values["allow-direct"] ? "direct calls allowed" : "gateway calls only"}`);
      await serveStdio(createMemoryServer(ledger, { requireGateway: !values["allow-direct"], ...(identity ? { identity } : {}) }));
      return 0;
    }
    case "sweep": {
      const { values } = parseArgs({ args: rest, options: { ledger: { type: "string" }, before: { type: "string" }, space: { type: "string" }, reason: { type: "string" }, actor: { type: "string", default: "cli" } } });
      if (!values.ledger || !values.before || !values.reason) throw new Error("sweep needs --ledger, --before, and --reason");
      const r = new Ledger(values.ledger).sweep({ before: new Date(values.before).toISOString(), ...(values.space ? { space: values.space } : {}), actor: values.actor, reason: values.reason });
      console.log(`forgot ${r.forgotten.length} fact(s); ${r.held.length} on hold, kept`);
      for (const f of r.forgotten) console.log(`  ${f.factId}  digest ${f.valueDigest.slice(0, 12)}`);
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

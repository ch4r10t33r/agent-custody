#!/usr/bin/env node
import { parseArgs } from "node:util";
import { Ledger } from "./ledger.ts";
import { createMemoryServer, serveStdio } from "./server.ts";
import { blastRadius, formatBlastRadius, loadReceipts } from "./blast.ts";
import { serveMemoryHttp } from "./http.ts";
import { loadPrivateKey, loadPublicKey } from "@agent-custody/receipts";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatReport, runAll, SCENARIOS } from "./evals.ts";
import { ledgerUnderTest, overwriteStoreUnderTest } from "./evals-ledger.ts";
import { loadScenarios, signReport, verifyReport } from "./evals-file.ts";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** The forget key from an environment variable, when named; a named but unset variable is an error at startup. */
function forgetKeyFrom(envName: string | undefined): { forgetKey?: string } {
  if (!envName) return {};
  const v = process.env[envName];
  if (!v) throw new Error(`forget key: environment variable ${envName} is not set`);
  return { forgetKey: v };
}

/** "org=P365D,team:*=P90D" into retention windows. */
function parseRetention(spec: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of spec.split(",")) {
    const [pattern, duration] = part.split("=").map((x) => x.trim());
    if (!pattern || !duration) throw new Error(`retention: expected space=duration, got "${part}"`);
    out[pattern] = duration;
  }
  return out;
}

const USAGE = `agent-custody-memory <command>

  serve --ledger <ledger.jsonl> [--allow-direct] [--key <memory.key>] [--forget-key-env NAME] [--retention 'org=P365D,team:*=P90D']
                                                   --forget-key-env names a secret kept outside the ledger; forgotten values then leave an HMAC, not a guessable hash.
                                                   the memory server over stdio; run it as the receipts gateway's upstream.
                                                   --key signs every result for its receipt, so executions verify as attested by this server.
                                                   By default it refuses calls that did not come through the gateway.
  serve --ledger <ledger.jsonl> --http [--port 8790] [--host 127.0.0.1] [--token-env NAME] [--allow-direct]
                                                   the same server shared over HTTP: several gateways, one ledger
  sweep --via <gateway.json> --reason <text> [--before <ISO instant>] [--space <space>] [--no-digest]
                                                   retention as a receipted call: runs memory.sweep through that gateway, as the principal in its grant.
                                                   Without --before, the memory server's --retention windows decide. Put this on a timer.
  sweep --ledger <ledger.jsonl> --before <ISO instant> [--space <space>] --reason <text> [--actor <id>] [--forget-key-env NAME] [--no-digest]
                                                   retention on the ledger file alone, for ledgers with no gateway or stores in front of them.
  eval [--scenarios <file.json>] [--baseline] [--json] [--sign <key> --out <report.json>]
                                                   runs the memory-mutation scenarios on a fresh ledger; --baseline also scores a naive
                                                   overwrite store; --sign writes a signed report. Exits 1 if the ledger regresses.
  eval --verify <report.json> --key <pub>          checks a signed report and prints its scores
  blast --ledger <ledger.jsonl> --receipts <dir> --fact <factId> [--json]
                                                   everything that relied on a fact: later calls, derived beliefs, and whether it was retracted
`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "serve": {
      const { values } = parseArgs({ args: rest, options: { ledger: { type: "string" }, "allow-direct": { type: "boolean", default: false }, http: { type: "boolean", default: false }, port: { type: "string", default: "8790" }, host: { type: "string", default: "127.0.0.1" }, "token-env": { type: "string" }, key: { type: "string" }, "forget-key-env": { type: "string" }, retention: { type: "string" } } });
      if (!values.ledger) throw new Error("serve needs --ledger");
      const ledger = new Ledger(values.ledger, forgetKeyFrom(values["forget-key-env"]));
      const identity = values.key ? loadPrivateKey(values.key) : undefined;
      const retention = values.retention ? parseRetention(values.retention) : undefined;
      const common = { requireGateway: !values["allow-direct"], ...(identity ? { identity } : {}), ...(retention ? { retention } : {}) };
      if (values.http) {
        const token = values["token-env"] ? process.env[values["token-env"]] : undefined;
        if (values["token-env"] && !token) throw new Error(`serve: environment variable ${values["token-env"]} is not set`);
        const running = await serveMemoryHttp(ledger, { port: Number(values.port), host: values.host, ...common, ...(token ? { tokens: [token] } : {}) });
        console.error(`agent-custody-memory: ${running.url} ledger=${values.ledger} events=${ledger.size} ${token ? "bearer token required" : "open"} ${values["allow-direct"] ? "direct calls allowed" : "gateway calls only"}`);
        await new Promise<void>((resolve) => process.once("SIGINT", resolve));
        await running.close();
        return 0;
      }
      console.error(`agent-custody-memory: ledger=${values.ledger} events=${ledger.size} ${values["allow-direct"] ? "direct calls allowed" : "gateway calls only"}`);
      await serveStdio(createMemoryServer(ledger, common));
      return 0;
    }
    case "sweep": {
      const { values } = parseArgs({ args: rest, options: { ledger: { type: "string" }, via: { type: "string" }, before: { type: "string" }, space: { type: "string" }, reason: { type: "string" }, actor: { type: "string", default: "cli" }, "forget-key-env": { type: "string" }, "no-digest": { type: "boolean", default: false } } });
      if (values.via) {
        // Retention as a receipted call: spawn the gateway from its config and call memory.sweep through it, so the
        // sweep runs as the principal named in that gateway's grant and its receipt is the record.
        if (!values.reason) throw new Error("sweep --via needs --reason");
        const gatewayCli = fileURLToPath(import.meta.resolve("@agent-custody/receipts/cli"));
        const client = new Client({ name: "agent-custody-memory-sweep", version: "0" });
        await client.connect(new StdioClientTransport({ command: process.execPath, args: [gatewayCli, "gateway", "--config", values.via], stderr: "inherit" }));
        try {
          const r = await client.callTool({ name: "memory.sweep", arguments: { reason: values.reason, ...(values.before ? { before: new Date(values.before).toISOString() } : {}), ...(values.space ? { space: values.space } : {}), ...(values["no-digest"] ? { keepDigest: false } : {}) } });
          const text = ((r as { content: { type: string; text?: string }[] }).content.find((c) => c.type === "text")?.text) ?? "";
          console.log(text);
          return (r as { isError?: boolean }).isError ? 1 : 0;
        } finally {
          await client.close();
        }
      }
      if (!values.ledger || !values.before || !values.reason) throw new Error("sweep needs --ledger, --before, and --reason, or --via <gateway.json> --reason");
      const r = new Ledger(values.ledger, forgetKeyFrom(values["forget-key-env"])).sweep({ before: new Date(values.before).toISOString(), ...(values.space ? { space: values.space } : {}), actor: values.actor, reason: values.reason, ...(values["no-digest"] ? { keepDigest: false } : {}) });
      console.log(`forgot ${r.forgotten.length} fact(s); ${r.held.length} on hold, kept`);
      for (const f of r.forgotten) console.log(`  ${f.factId}  ${f.digestKind}${f.valueDigest ? ` ${f.valueDigest.slice(0, 12)}` : ""}`);
      return 0;
    }
    case "eval": {
      const { values } = parseArgs({ args: rest, options: { scenarios: { type: "string" }, baseline: { type: "boolean", default: false }, json: { type: "boolean", default: false }, sign: { type: "string" }, out: { type: "string" }, verify: { type: "string" }, key: { type: "string", multiple: true } } });
      if (values.verify) {
        if (!values.key?.length) throw new Error("eval --verify needs --key <pub>");
        const r = verifyReport(JSON.parse(readFileSync(values.verify, "utf8")), values.key.map(loadPublicKey));
        if (!r.ok) {
          console.log(`NOT VERIFIED: ${r.error}`);
          return 1;
        }
        console.log(`VERIFIED  signed by ${r.keyid.slice(0, 12)}  system ${r.predicate.system}  ran ${r.predicate.ranAt}  scenarios ${r.predicate.scenarioNames.length} (digest ${r.predicate.scenariosDigest.slice(0, 12)})`);
        console.log(formatReport(r.predicate.report));
        return 0;
      }
      const scenarios = values.scenarios ? loadScenarios(values.scenarios) : SCENARIOS;
      const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "agent-custody-eval-")), "ledger.jsonl"));
      const report = await runAll(ledgerUnderTest(ledger), scenarios);
      const baseline = values.baseline ? await runAll(overwriteStoreUnderTest(), scenarios) : null;
      const regressed = report.totals.correctReads < report.totals.reads || report.scenarios.some((s) => s.failures.length > 0);
      if (values.json) console.log(JSON.stringify({ ledger: report, baseline }, null, 2));
      else {
        console.log("The ledger:");
        console.log(formatReport(report));
        if (baseline) {
          console.log("\nA naive overwrite store:");
          console.log(formatReport(baseline));
        }
      }
      if (values.sign) {
        if (!values.out) throw new Error("eval --sign needs --out <report.json>");
        writeFileSync(values.out, JSON.stringify(signReport("agent-custody-ledger", scenarios, report, loadPrivateKey(values.sign)), null, 2));
        console.error(`signed report written to ${values.out}`);
      }
      return regressed ? 1 : 0;
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

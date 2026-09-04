#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { generateKeyPair, loadPrivateKey, loadPublicKey, writeKeyPair } from "./crypto.ts";
import { createDelegation } from "./delegation.ts";
import { createGateway, serveStdio } from "./gateway.ts";
import type { ReceiptBundle } from "./receipt.ts";
import { formatReport, verifyBundle } from "./verify.ts";

const USAGE = `agent-receipts <command>

  keygen  --dir <dir> --name <name>
  grant   --key <principal.key> --principal <id> --agent <id> --scopes <a,b> [--ttl-hours 24] --out <file>
  gateway --config <gateway.json>
  verify  <bundle.json> --gateway-key <pub> --principal-key <pub> [--log <log.jsonl>] [--json]
`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "keygen": {
      const { values } = parseArgs({ args: rest, options: { dir: { type: "string" }, name: { type: "string" } } });
      if (!values.dir || !values.name) throw new Error("keygen needs --dir and --name");
      const kp = generateKeyPair();
      const files = writeKeyPair(kp, values.dir, values.name);
      console.log(`keyid ${kp.keyid}\nprivate ${files.keyFile}\npublic  ${files.pubFile}`);
      return 0;
    }
    case "grant": {
      const { values } = parseArgs({
        args: rest,
        options: {
          key: { type: "string" },
          principal: { type: "string" },
          agent: { type: "string" },
          scopes: { type: "string" },
          "ttl-hours": { type: "string", default: "24" },
          out: { type: "string" },
        },
      });
      if (!values.key || !values.principal || !values.agent || !values.scopes || !values.out) throw new Error("grant needs --key --principal --agent --scopes --out");
      const now = Date.now();
      const env = createDelegation(loadPrivateKey(values.key), {
        version: "0.1",
        principal: values.principal,
        agent: values.agent,
        scopes: values.scopes.split(",").map((s) => s.trim()).filter(Boolean),
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + Number(values["ttl-hours"]) * 3600_000).toISOString(),
      });
      writeFileSync(values.out, JSON.stringify(env, null, 2));
      console.log(`wrote ${values.out}`);
      return 0;
    }
    case "gateway": {
      const { values } = parseArgs({ args: rest, options: { config: { type: "string" } } });
      if (!values.config) throw new Error("gateway needs --config");
      const gw = await createGateway(loadConfig(values.config));
      console.error(`agent-receipts gateway: agent=${gw.agentId} principal=${gw.delegation.principal} scopes=[${gw.delegation.scopes.join(", ")}]`);
      await serveStdio(gw);
      await gw.close();
      return 0;
    }
    case "verify": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          "gateway-key": { type: "string", multiple: true },
          "principal-key": { type: "string", multiple: true },
          log: { type: "string" },
          json: { type: "boolean", default: false },
        },
      });
      const file = positionals[0];
      if (!file || !values["gateway-key"]?.length || !values["principal-key"]?.length) throw new Error("verify needs <bundle> --gateway-key --principal-key");
      const bundle = JSON.parse(readFileSync(file, "utf8")) as ReceiptBundle;
      const result = verifyBundle(bundle, {
        gatewayKeys: values["gateway-key"].map(loadPublicKey),
        principalKeys: values["principal-key"].map(loadPublicKey),
        ...(values.log ? { logFile: values.log } : {}),
      });
      console.log(values.json ? JSON.stringify(result, null, 2) : formatReport(result));
      return result.ok ? 0 : 1;
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

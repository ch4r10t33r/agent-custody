#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { loadConfig, loadSdkConfig } from "./config.ts";
import { generateKeyPair, loadPrivateKey, loadPublicKey, writeKeyPair } from "./crypto.ts";
import { createDelegation } from "./delegation.ts";
import { createGateway, serveStdio } from "./gateway.ts";
import { serveLog } from "./log-sink.ts";
import type { ReceiptBundle } from "./receipt.ts";
import { createSdkIssuer } from "./sdk/index.ts";
import { handleHookEvent, type HookInput } from "./sdk/claude.ts";
import { formatReport, verifyBundle } from "./verify.ts";

const USAGE = `agent-custody <command>

  keygen  --dir <dir> --name <name>
  grant   --key <principal.key> --principal <id> --agent <id> --scopes <a,b> [--ttl-hours 24] --out <file>
  gateway --config <gateway.json>
  hook    [--config <sdk.json>]        Claude Code hook command; reads the event on stdin (or AGENT_CUSTODY_CONFIG)
  log     --file <log.jsonl> --key <log.key> [--port 8787] [--host 127.0.0.1] [--token-env <NAME>]   reference log server
  verify  <bundle.json> --issuer-key <pub> [--principal-key <pub>] [--log-key <pub>] [--log <log.jsonl>] [--json]
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
      console.error(`agent-custody gateway: agent=${gw.agentId} principal=${gw.delegation.principal} scopes=[${gw.delegation.scopes.join(", ")}]`);
      await serveStdio(gw);
      await gw.close();
      return 0;
    }
    case "hook": {
      const { values } = parseArgs({ args: rest, options: { config: { type: "string" } } });
      const configPath = values.config ?? process.env.AGENT_CUSTODY_CONFIG;
      if (!configPath) throw new Error("hook needs --config or AGENT_CUSTODY_CONFIG");
      const input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
      const out = await handleHookEvent(createSdkIssuer(loadSdkConfig(configPath)), input);
      console.log(JSON.stringify(out));
      return 0;
    }
    case "log": {
      const { values } = parseArgs({
        args: rest,
        options: { file: { type: "string" }, key: { type: "string" }, port: { type: "string", default: "8787" }, host: { type: "string", default: "127.0.0.1" }, "token-env": { type: "string" } },
      });
      if (!values.file || !values.key) throw new Error("log needs --file and --key");
      const token = values["token-env"] ? process.env[values["token-env"]] : undefined;
      if (values["token-env"] && !token) throw new Error(`log: environment variable ${values["token-env"]} is not set`);
      const key = loadPrivateKey(values.key);
      const running = await serveLog(values.file, key, { port: Number(values.port), host: values.host, ...(token ? { tokens: [token] } : {}) });
      console.error(`agent-custody log: ${running.url} keyid=${key.keyid} file=${values.file} ${token ? "bearer token required" : "open, anyone may append"}`);
      await new Promise<void>((resolve) => process.once("SIGINT", resolve));
      await running.close();
      return 0;
    }
    case "verify": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          "issuer-key": { type: "string", multiple: true },
          "gateway-key": { type: "string", multiple: true },
          "principal-key": { type: "string", multiple: true },
          "log-key": { type: "string", multiple: true },
          log: { type: "string" },
          json: { type: "boolean", default: false },
        },
      });
      const file = positionals[0];
      const issuerKeyFiles = [...(values["issuer-key"] ?? []), ...(values["gateway-key"] ?? [])];
      if (!file || issuerKeyFiles.length === 0) throw new Error("verify needs <bundle> --issuer-key (alias --gateway-key)");
      const bundle = JSON.parse(readFileSync(file, "utf8")) as ReceiptBundle;
      const result = verifyBundle(bundle, {
        issuerKeys: issuerKeyFiles.map(loadPublicKey),
        principalKeys: (values["principal-key"] ?? []).map(loadPublicKey),
        ...(values["log-key"] ? { logKeys: values["log-key"].map(loadPublicKey) } : {}),
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

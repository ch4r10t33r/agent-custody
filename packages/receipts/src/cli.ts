#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig, loadSdkConfig } from "./config.ts";
import { generateKeyPair, loadPrivateKey, loadPublicKey, writeKeyPair } from "./crypto.ts";
import { createDelegation } from "./delegation.ts";
import { createGateway, serveStdio } from "./gateway.ts";
import { postgresResolver, serveLog } from "./log-sink.ts";
import { importLogFile, PostgresTenancy, type PostgresLike } from "./log-store.ts";
import { bothCheckpoints, dirCheckpoints, postgresCheckpoints, type CheckpointStore } from "./checkpoints.ts";
import { connectSigner, fetchLogKeys, localSigner, serveSigner, type RetiredKey, type Signer } from "./signer.ts";
import { CheckpointPublisher, fileResolver, type LogResolver } from "./log-sink.ts";
import type { AdminOptions } from "./log-admin.ts";
import { createRequire } from "node:module";
import { pruneLog } from "./retention.ts";
import { serveSidecar } from "./sidecar.ts";
import type { ReceiptBundle, TreeHead } from "./receipt.ts";
import type { Envelope } from "./crypto.ts";
import { MerkleLog } from "./log.ts";
import { createSdkIssuer } from "./sdk/index.ts";
import { handleHookEvent, type HookInput } from "./sdk/claude.ts";
import { auditExtends, formatReport, verifyBundle } from "./verify.ts";

/** A shared secret from an environment variable; never from the command line, where it would land in shell history. */
function secretFrom(envName: string): string {
  const v = process.env[envName];
  if (!v) throw new Error(`environment variable ${envName} is not set`);
  return v;
}

const USAGE = `agent-custody <command>

  keygen  --dir <dir> --name <name>
  grant   --key <principal.key> --principal <id> --agent <id> --scopes <a,b> [--ttl-hours 24] --out <file>
  gateway --config <gateway.json>
  hook    [--config <sdk.json>]        Claude Code hook command; reads the event on stdin (or AGENT_CUSTODY_CONFIG)
  serve   --config <sdk.json> [--port 8788] [--host 127.0.0.1]   the SDK as a local HTTP API for agents in other languages
  prune   --log <log.jsonl> --before <ISO instant> [--receipts <dir>]
          retention on the receipt log: replaces older leaves with their hashes, so proofs still verify and the content is gone
  log     --file <log.jsonl> --key <log.key> [--port 8787] [--host 127.0.0.1] [--token-env <NAME>]   reference log server
  verify  <bundle.json> --issuer-key <pub> [--principal-key <pub>] [--log-key <pub> | --log-url <url>] [--log-id <id>] [--upstream-key <pub>] [--stripe-secret-env NAME] [--github-secret-env NAME] [--log <log.jsonl>] [--json]
  log     ... --db-env NAME                     the same server over Postgres: tenants and tokens from the database, one writer per tenant,
                                                 root paths serve the tenant "default" (created with --log-id). Needs the pg package.
  log     ... (--key <log.key> [--retired-key <pub>]... | --signer-url <url> [--signer-token-env NAME]) [--checkpoint-dir <dir>] [--checkpoint-every <seconds>]
                                                 sign with a key in this process, or through a signer process that holds it; publish a signed
                                                 checkpoint per log that has grown, every 300 s by default, to the directory (and, with a
                                                 database, to its heads table); serve the key document at /.well-known/agent-custody-log.json
  log     ... --db-env NAME --admin-token-env NAME [--public-url <https://log.example.com/>] [--checkpoints-url <https://checkpoints.example.com/>]
                                                 the operator's admin page at /admin and its API, behind the admin token: tenants, tokens shown once,
                                                 the welcome sheet; the public URLs fill the sheet in
  signer  --key <log.key> --port 8790 [--host 127.0.0.1] [--token-env NAME] [--retired-key <pub>]...
                                                 the one process that holds the log's key: POST /sign, GET /keys
  log-admin --db-env NAME tenant add <id> [--log-id <id>] | tenant list | tenant disable <id>
  log-admin --db-env NAME token add <tenant> --label <text> | token list <tenant> | token revoke <tenant> <hash-prefix>
  log-admin --db-env NAME import --file <log.jsonl> [--tenant default]      copies a file log into the database as hashes
  audit   --older <bundle.json> --newer <bundle.json> (--log <log.jsonl> | --log-url <url>) [--issuer-key <pub>] [--log-key <pub>] [--log-id <id>] [--json]
                                                 with --log-url the log's published keys are fetched and pinned by keyid
          checks that the newer receipt's log extends the older one's: nothing between them was rewritten
`;

/** A retired public key for the key document, from a .pub file; still listed so heads it signed keep verifying. */
function retiredKey(pubFile: string): RetiredKey {
  return { key: loadPublicKey(pubFile), pem: readFileSync(pubFile, "utf8") };
}

/** A pg Pool from the URL in an environment variable. pg is an optional peer: it is loaded only here, and its absence says what to install. */
function openPostgres(envName: string): PostgresLike {
  const url = process.env[envName];
  if (!url) throw new Error(`environment variable ${envName} is not set`);
  let Pool: new (o: { connectionString: string }) => PostgresLike;
  try {
    ({ Pool } = createRequire(import.meta.url)("pg") as { Pool: typeof Pool });
  } catch {
    throw new Error("a Postgres log needs the pg package: npm install pg");
  }
  return new Pool({ connectionString: url });
}

/** The tenants file for `log --tenants`: paths relative to the file, tokens from the environment, ids default to the tenant name. */
function loadTenants(path: string): Record<string, { file: string; tokens?: string[]; logId?: string }> {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, { file: string; tokenEnv?: string; logId?: string }>;
  const out: Record<string, { file: string; tokens?: string[]; logId?: string }> = {};
  for (const [name, t] of Object.entries(raw)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || typeof t?.file !== "string") throw new Error(`tenants: "${name}" needs a file, and its name must be a plain identifier`);
    const token = t.tokenEnv ? process.env[t.tokenEnv] : undefined;
    if (t.tokenEnv && !token) throw new Error(`tenants: environment variable ${t.tokenEnv} for "${name}" is not set`);
    out[name] = { file: resolve(dirname(resolve(path)), t.file), ...(token ? { tokens: [token] } : {}), ...(t.logId ? { logId: t.logId } : {}) };
  }
  return out;
}

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
    case "serve": {
      const { values } = parseArgs({ args: rest, options: { config: { type: "string" }, port: { type: "string", default: "8788" }, host: { type: "string", default: "127.0.0.1" } } });
      if (!values.config) throw new Error("serve needs --config");
      const issuer = createSdkIssuer(loadSdkConfig(values.config));
      const running = await serveSidecar(issuer, { port: Number(values.port), host: values.host });
      console.error(`agent-custody serve: ${running.url} agent=${issuer.agentId} keyid=${issuer.keyid} log=${issuer.log.kind}:${issuer.log.where}`);
      await new Promise<void>((resolve) => process.once("SIGINT", resolve));
      await running.close();
      return 0;
    }
    case "signer": {
      const { values } = parseArgs({ args: rest, options: { key: { type: "string" }, port: { type: "string", default: "8790" }, host: { type: "string", default: "127.0.0.1" }, "token-env": { type: "string" }, "retired-key": { type: "string", multiple: true } } });
      if (!values.key) throw new Error("signer needs --key");
      const token = values["token-env"] ? process.env[values["token-env"]] : undefined;
      if (values["token-env"] && !token) throw new Error(`signer: environment variable ${values["token-env"]} is not set`);
      const kp = loadPrivateKey(values.key);
      const running = await serveSigner(kp, { port: Number(values.port), host: values.host, ...(token ? { token } : {}), retired: (values["retired-key"] ?? []).map(retiredKey) });
      console.error(`agent-custody signer: ${running.url} keyid=${kp.keyid} ${token ? "token required" : "open: bind this to a private network"}${values["retired-key"]?.length ? ` retired=${values["retired-key"].length}` : ""}`);
      await new Promise<void>((resolve) => process.once("SIGINT", resolve));
      await running.close();
      return 0;
    }
    case "log-admin": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { "db-env": { type: "string" }, "log-id": { type: "string" }, label: { type: "string" }, file: { type: "string" }, tenant: { type: "string", default: "default" } } });
      if (!values["db-env"]) throw new Error("log-admin needs --db-env NAME");
      const tenancy = new PostgresTenancy(openPostgres(values["db-env"]));
      const [what, verb, ...args] = positionals;
      if (what === "tenant" && verb === "add" && args[0]) {
        const t = await tenancy.addTenant(args[0], values["log-id"] ?? args[0]);
        console.log(`tenant ${t.id} log=${t.logId} reached at /t/${t.id}/`);
      } else if (what === "tenant" && verb === "list") {
        for (const t of await tenancy.listTenants()) console.log(`${t.id.padEnd(24)} log=${t.logId.padEnd(28)} created ${t.createdAt}${t.disabledAt ? `  DISABLED ${t.disabledAt}` : ""}`);
      } else if (what === "tenant" && verb === "disable" && args[0]) {
        await tenancy.disableTenant(args[0]);
        console.log(`tenant ${args[0]} disabled`);
      } else if (what === "token" && verb === "add" && args[0]) {
        if (!values.label) throw new Error("token add needs --label");
        const { token, tokenHash } = await tenancy.addToken(args[0], values.label);
        console.error(`token for ${args[0]} (${values.label}); shown once, stored as hash ${tokenHash.slice(0, 12)}…:`);
        console.log(token);
      } else if (what === "token" && verb === "list" && args[0]) {
        for (const t of await tenancy.listTokens(args[0])) console.log(`${t.tokenHash.slice(0, 12)}  ${t.label.padEnd(24)} created ${t.createdAt}${t.revokedAt ? `  REVOKED ${t.revokedAt}` : ""}`);
      } else if (what === "token" && verb === "revoke" && args[0] && args[1]) {
        console.log(`revoked ${await tenancy.revokeToken(args[0], args[1])} token(s)`);
      } else if (what === "import") {
        if (!values.file) throw new Error("import needs --file <log.jsonl>");
        if (!(await tenancy.tenant(values.tenant))) throw new Error(`unknown tenant ${values.tenant}; add it first`);
        const r = await importLogFile(values.file, await tenancy.log(values.tenant));
        console.log(`imported ${r.added} leaf hash(es) into ${values.tenant}; the log now has ${r.total}`);
      } else {
        console.error(USAGE);
        return 2;
      }
      return 0;
    }
    case "prune": {
      const { values } = parseArgs({ args: rest, options: { log: { type: "string" }, before: { type: "string" }, receipts: { type: "string" } } });
      if (!values.log || !values.before) throw new Error("prune needs --log and --before");
      const r = pruneLog(values.log, new Date(values.before).toISOString(), values.receipts);
      console.log(`pruned ${r.pruned.length} leaf(s), kept ${r.kept}, removed ${r.bundlesRemoved} bundle file(s)`);
      for (const p of r.pruned) console.log(`  leaf ${p.leafIndex}  ${p.timestamp}  receipt ${p.receiptId ?? "?"}`);
      return 0;
    }
    case "log": {
      const { values } = parseArgs({
        args: rest,
        options: { file: { type: "string" }, key: { type: "string" }, port: { type: "string", default: "8787" }, host: { type: "string", default: "127.0.0.1" }, "token-env": { type: "string" }, "log-id": { type: "string" }, tenants: { type: "string" }, "db-env": { type: "string" }, "signer-url": { type: "string" }, "signer-token-env": { type: "string" }, "retired-key": { type: "string", multiple: true }, "checkpoint-dir": { type: "string" }, "checkpoint-every": { type: "string", default: "300" }, "admin-token-env": { type: "string" }, "public-url": { type: "string" }, "checkpoints-url": { type: "string" } },
      });
      if (!values.key === !values["signer-url"]) throw new Error("log needs exactly one of --key or --signer-url");
      const token = values["token-env"] ? process.env[values["token-env"]] : undefined;
      if (values["token-env"] && !token) throw new Error(`log: environment variable ${values["token-env"]} is not set`);
      // The signer: a key in this process, or the signer service that holds it.
      let signer: Signer;
      if (values.key) signer = localSigner(loadPrivateKey(values.key), { retired: (values["retired-key"] ?? []).map(retiredKey) });
      else {
        const st = values["signer-token-env"] ? process.env[values["signer-token-env"]] : undefined;
        if (values["signer-token-env"] && !st) throw new Error(`log: environment variable ${values["signer-token-env"]} is not set`);
        signer = await connectSigner(values["signer-url"]!, st ? { token: st } : {});
      }
      const everyMs = Number(values["checkpoint-every"]) * 1000;
      if (!(everyMs > 0)) throw new Error("--checkpoint-every must be a positive number of seconds");
      let resolver: LogResolver;
      let checkpoints: CheckpointStore | undefined = values["checkpoint-dir"] ? dirCheckpoints(values["checkpoint-dir"]) : undefined;
      let where: string;
      let admin: AdminOptions | undefined;
      if (values["db-env"]) {
        // Postgres: the file is not used; tenants, tokens, leaves, and checkpoints live in the database.
        const client = openPostgres(values["db-env"]);
        const tenancy = new PostgresTenancy(client);
        const defaultId = values["log-id"] ?? "default";
        if (!(await tenancy.tenant("default"))) await tenancy.addTenant("default", defaultId);
        resolver = postgresResolver(tenancy, { defaultTenant: "default", ...(token ? { staticTokens: [token] } : {}) });
        const table = postgresCheckpoints(client);
        checkpoints = checkpoints ? bothCheckpoints(table, checkpoints) : table;
        if (values["admin-token-env"]) {
          const adminToken = process.env[values["admin-token-env"]];
          if (!adminToken) throw new Error(`log: environment variable ${values["admin-token-env"]} is not set`);
          admin = { tenancy, token: adminToken, ...(values["public-url"] ? { publicUrl: values["public-url"] } : {}), ...(values["checkpoints-url"] ? { checkpointsUrl: values["checkpoints-url"] } : {}) };
        }
        where = `store=postgres default-log=${(await tenancy.tenant("default"))?.logId} ${token ? "environment token accepted for the default log; " : ""}tokens from the database`;
      } else {
        if (values["admin-token-env"]) throw new Error("the admin page needs --db-env; tenants live in the database");
        if (!values.file) throw new Error("log needs --file, or --db-env");
        // --tenants names a JSON file { "<tenant>": { "file": "...", "tokenEnv": "NAME", "logId": "..." } }; each is reached at /t/<tenant>/.
        const tenants = values.tenants ? loadTenants(values.tenants) : undefined;
        resolver = fileResolver(values.file, { ...(token ? { tokens: [token] } : {}), ...(values["log-id"] ? { logId: values["log-id"] } : {}), ...(tenants ? { tenants } : {}) });
        where = `file=${values.file}${values["log-id"] ? ` log=${values["log-id"]}` : ""} ${token ? "bearer token required" : "open, anyone may append"}${tenants ? ` tenants=${Object.keys(tenants).join(",")}` : ""}`;
      }
      const running = await serveLog(resolver, signer, { port: Number(values.port), host: values.host, ...(checkpoints ? { checkpoints } : {}), ...(admin ? { admin } : {}) });
      const publisher = checkpoints ? new CheckpointPublisher(resolver, signer, checkpoints, everyMs) : null;
      publisher?.start();
      console.error(`agent-custody log: ${running.url} keyid=${signer.keyid} ${values["signer-url"] ? `signer=${values["signer-url"]} ` : ""}${where}${checkpoints ? ` checkpoints every ${values["checkpoint-every"]}s${values["checkpoint-dir"] ? ` to ${values["checkpoint-dir"]}` : ""}` : ""}${admin ? " admin page at /admin" : ""}`);
      await new Promise<void>((resolve) => process.once("SIGINT", resolve));
      publisher?.stop();
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
          "log-url": { type: "string" },
          "log-id": { type: "string" },
          "upstream-key": { type: "string", multiple: true },
          "stripe-secret-env": { type: "string" },
          "github-secret-env": { type: "string" },
          log: { type: "string" },
          json: { type: "boolean", default: false },
        },
      });
      const file = positionals[0];
      const issuerKeyFiles = [...(values["issuer-key"] ?? []), ...(values["gateway-key"] ?? [])];
      if (!file || issuerKeyFiles.length === 0) throw new Error("verify needs <bundle> --issuer-key (alias --gateway-key)");
      const bundle = JSON.parse(readFileSync(file, "utf8")) as ReceiptBundle;
      const fetchedLogKeys = values["log-url"] ? (await fetchLogKeys(values["log-url"])).keys : [];
      const logKeys = [...(values["log-key"] ?? []).map(loadPublicKey), ...fetchedLogKeys];
      const result = verifyBundle(bundle, {
        issuerKeys: issuerKeyFiles.map(loadPublicKey),
        principalKeys: (values["principal-key"] ?? []).map(loadPublicKey),
        ...(logKeys.length ? { logKeys } : {}),
        ...(values["log-id"] ? { logId: values["log-id"] } : {}),
        ...(values["upstream-key"] ? { upstreamKeys: values["upstream-key"].map(loadPublicKey) } : {}),
        ...(values["stripe-secret-env"] || values["github-secret-env"] ? { providerSecrets: { ...(values["stripe-secret-env"] ? { stripe: secretFrom(values["stripe-secret-env"]) } : {}), ...(values["github-secret-env"] ? { github: secretFrom(values["github-secret-env"]) } : {}) } } : {}),
        ...(values.log ? { logFile: values.log } : {}),
      });
      console.log(values.json ? JSON.stringify(result, null, 2) : formatReport(result));
      return result.ok ? 0 : 1;
    }
    case "audit": {
      const { values } = parseArgs({
        args: rest,
        options: {
          older: { type: "string" },
          newer: { type: "string" },
          log: { type: "string" },
          "log-url": { type: "string" },
          "issuer-key": { type: "string", multiple: true },
          "log-key": { type: "string", multiple: true },
          "log-id": { type: "string" },
          json: { type: "boolean", default: false },
        },
      });
      const keyFiles = [...(values["issuer-key"] ?? []), ...(values["log-key"] ?? [])];
      if (!values.older || !values.newer) throw new Error("audit needs --older and --newer");
      if (!values.log === !values["log-url"]) throw new Error("audit needs exactly one of --log or --log-url");
      const auditKeys = [...keyFiles.map(loadPublicKey), ...(values["log-url"] ? (await fetchLogKeys(values["log-url"])).keys : [])];
      if (auditKeys.length === 0) throw new Error("audit needs a key: --issuer-key, --log-key, or a --log-url that publishes its keys");
      const older = (JSON.parse(readFileSync(values.older, "utf8")) as ReceiptBundle).treeHead;
      const newer = (JSON.parse(readFileSync(values.newer, "utf8")) as ReceiptBundle).treeHead;
      const sizeOf = (env: Envelope) => (JSON.parse(Buffer.from(env.payload, "base64").toString()) as TreeHead).treeSize;
      const [m, n] = [sizeOf(older), sizeOf(newer)];
      let proof: string[];
      if (values.log) proof = new MerkleLog(values.log).consistencyProof(Math.min(m, n), Math.max(m, n));
      else {
        const res = await fetch(new URL(`consistency?old=${Math.min(m, n)}&new=${Math.max(m, n)}`, values["log-url"]!.endsWith("/") ? values["log-url"]! : `${values["log-url"]}/`));
        if (!res.ok) throw new Error(`log refused the consistency query: ${res.status}`);
        proof = ((await res.json()) as { hashes: string[] }).hashes;
      }
      const result = auditExtends(older, newer, proof, auditKeys, values["log-id"]);
      if (values.json) console.log(JSON.stringify(result, null, 2));
      else {
        for (const c of result.checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
        console.log(`\nRESULT: ${result.ok ? "NEWER LOG EXTENDS OLDER LOG" : "NOT CONSISTENT"}`);
      }
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

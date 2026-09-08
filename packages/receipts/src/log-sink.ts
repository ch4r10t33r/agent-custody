// Where log leaves go.
// The file sink is the local Merkle log, with tree heads signed by the issuer's own key: tamper-evident, but the
// operator holds the file. The HTTP sink hands each leaf to a log run by someone else, who signs the tree head with
// their key. A verifier who trusts that key learns the receipt was in a log the operator cannot rewrite.
// logHandler and serveLog are the other side: a reference log server over node:http, the same code a hosted log runs.
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dsseSign, type Envelope, type KeyPair } from "./crypto.ts";
import { leafHash, MerkleLog, type InclusionProof } from "./log.ts";
import { TREEHEAD_TYPE, type TreeHead } from "./receipt.ts";

export interface LogAppend {
  inclusion: InclusionProof;
  /** signed TreeHead; the signature's keyid says who runs the log */
  treeHead: Envelope;
}

export interface LogSink {
  readonly kind: "file" | "http";
  /** the file path or the URL, for reports */
  readonly where: string;
  append(leaf: string): Promise<LogAppend>;
}

function appendSigned(log: MerkleLog, key: KeyPair, leaf: { leaf: string } | { leafHash: string }, logId?: string): LogAppend {
  const e = "leaf" in leaf ? log.append(leaf.leaf) : log.appendHash(leaf.leafHash);
  const head: TreeHead = { treeSize: e.treeSize, rootHash: e.rootHash, timestamp: new Date().toISOString(), ...(logId ? { log: logId } : {}) };
  return { inclusion: { leafIndex: e.leafIndex, treeSize: e.treeSize, hashes: e.hashes }, treeHead: dsseSign(TREEHEAD_TYPE, head, key) };
}

/** A local JSONL Merkle log. Tree heads are signed with the given key, normally the issuer's own. */
export function fileLog(file: string, key: KeyPair): LogSink {
  const log = new MerkleLog(file);
  return {
    kind: "file",
    where: file,
    async append(leaf) {
      return appendSigned(log, key, { leaf });
    },
  };
}

export interface HttpLogOptions {
  /** sent as a bearer token; the log decides what it is worth */
  token?: string;
  /** send only the leaf hash; the log then commits to the receipt without ever holding it. Use it for any log run by someone else. */
  hashOnly?: boolean;
  fetch?: typeof fetch;
}

/** A log reached over HTTP: POST <url>/append with {leaf}, expecting a LogAppend back. */
export function httpLog(url: string, opts: HttpLogOptions = {}): LogSink {
  const f = opts.fetch ?? fetch;
  const base = url.endsWith("/") ? url : `${url}/`;
  return {
    kind: "http",
    where: url,
    async append(leaf) {
      const res = await f(new URL("append", base), {
        method: "POST",
        headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
        body: JSON.stringify(opts.hashOnly ? { leafHash: leafHash(leaf).toString("hex") } : { leaf }),
      });
      if (!res.ok) throw new Error(`log ${url} refused the append: ${res.status} ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as Partial<LogAppend>;
      if (!body.inclusion || !body.treeHead) throw new Error(`log ${url} returned a malformed append result`);
      return body as LogAppend;
    },
  };
}

export interface LogConfig {
  logFile?: string | undefined;
  log?: { url: string; tokenEnv?: string | undefined; hashOnly?: boolean | undefined } | undefined;
}

/** The sink a config asks for: a remote log when `log` is set, otherwise the local file. */
export function openLog(cfg: LogConfig, key: KeyPair): LogSink {
  if (cfg.log) {
    const token = cfg.log.tokenEnv ? process.env[cfg.log.tokenEnv] : undefined;
    if (cfg.log.tokenEnv && !token) throw new Error(`log token: environment variable ${cfg.log.tokenEnv} is not set`);
    return httpLog(cfg.log.url, { ...(token === undefined ? {} : { token }), ...(cfg.log.hashOnly ? { hashOnly: true } : {}) });
  }
  if (!cfg.logFile) throw new Error("config needs logFile or log.url");
  return fileLog(cfg.logFile, key);
}

export interface LogServerOptions {
  /** bearer tokens accepted on append; when empty, anyone may append */
  tokens?: string[];
  /** the id written into every tree head this log signs, so a head cannot be presented as another log's */
  logId?: string;
  /**
   * More logs behind the same server, one per tenant, reached at /t/<tenant>/...: each with its own file, tokens,
   * and id. The default log stays at the root paths. This is the shape a hosted log takes; the reference server
   * runs it from a small JSON file.
   */
  tenants?: Record<string, { file: string; tokens?: string[]; logId?: string }>;
}

interface TenantLog {
  log: MerkleLog;
  tokens: string[];
  logId: string | undefined;
}

/**
 * The reference log server as a node:http request handler.
 *   POST /append  {leaf}   -> LogAppend, tree head signed with the log's key
 *   GET  /root?size=N      -> {treeSize, rootHash}, for auditors checking a tree head against the log
 *   GET  /consistency?old=M&new=N -> {oldSize, newSize, hashes}, proof that the log at N extends the log at M
 *   GET  /head             -> {treeHead}, the current tree head signed with the log's key
 */
export function logHandler(file: string, key: KeyPair, opts: LogServerOptions = {}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const root: TenantLog = { log: new MerkleLog(file), tokens: opts.tokens ?? [], logId: opts.logId };
  const tenants = new Map<string, TenantLog>();
  for (const [name, t] of Object.entries(opts.tenants ?? {})) tenants.set(name, { log: new MerkleLog(t.file), tokens: t.tokens ?? [], logId: t.logId ?? name });
  const authorized = (req: IncomingMessage, tokens: string[]): boolean => {
    if (tokens.length === 0) return true;
    const h = req.headers.authorization ?? "";
    const given = Buffer.from(h.startsWith("Bearer ") ? h.slice(7) : "");
    return tokens.some((t) => {
      const want = Buffer.from(t);
      return want.length === given.length && timingSafeEqual(want, given);
    });
  };
  return async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? "/", "http://localhost");
    // /t/<tenant>/<op> reaches that tenant's log; anything else is the default log.
    const m = /^\/t\/([A-Za-z0-9_.-]+)\/(append|root|consistency|head)$/.exec(url.pathname);
    const which = m ? tenants.get(m[1]!) : root;
    if (!which) return json(404, { error: "unknown log" });
    const { log, tokens, logId } = which;
    if (req.method === "POST" && url.pathname.endsWith("/append")) {
      if (!authorized(req, tokens)) return json(401, { error: "unauthorized" });
      let body = "";
      for await (const chunk of req) body += chunk;
      let parsed: { leaf?: unknown; leafHash?: unknown };
      try {
        parsed = JSON.parse(body) as { leaf?: unknown; leafHash?: unknown };
      } catch {
        return json(400, { error: "body must be JSON {leaf} or {leafHash}" });
      }
      if (typeof parsed.leafHash === "string") {
        if (!/^[0-9a-f]{64}$/.test(parsed.leafHash)) return json(400, { error: "leafHash must be 64 lowercase hex characters" });
        return json(200, appendSigned(log, key, { leafHash: parsed.leafHash }, logId));
      }
      if (typeof parsed.leaf !== "string" || parsed.leaf.length === 0) return json(400, { error: "leaf must be a non-empty string, or send leafHash" });
      return json(200, appendSigned(log, key, { leaf: parsed.leaf }, logId));
    }
    if (req.method === "GET" && url.pathname.endsWith("/root")) {
      const size = url.searchParams.has("size") ? Number(url.searchParams.get("size")) : log.size;
      if (!Number.isInteger(size) || size < 0 || size > log.size) return json(400, { error: `size must be an integer in 0..${log.size}` });
      return json(200, { treeSize: size, rootHash: log.root(size) });
    }
    if (req.method === "GET" && url.pathname.endsWith("/consistency")) {
      const oldSize = Number(url.searchParams.get("old"));
      const newSize = url.searchParams.has("new") ? Number(url.searchParams.get("new")) : log.size;
      if (![oldSize, newSize].every(Number.isInteger) || oldSize < 0 || oldSize > newSize || newSize > log.size) return json(400, { error: `old and new must be integers with 0 <= old <= new <= ${log.size}` });
      return json(200, { oldSize, newSize, hashes: log.consistencyProof(oldSize, newSize) });
    }
    if (req.method === "GET" && url.pathname.endsWith("/head")) {
      const head: TreeHead = { treeSize: log.size, rootHash: log.root(), timestamp: new Date().toISOString(), ...(logId ? { log: logId } : {}) };
      return json(200, { treeHead: dsseSign(TREEHEAD_TYPE, head, key) });
    }
    return json(404, { error: "not found" });
  };
}

export interface RunningLog {
  url: string;
  close(): Promise<void>;
}

/** Starts the reference log server. Port 0 picks a free port. */
export function serveLog(file: string, key: KeyPair, opts: LogServerOptions & { port: number; host?: string }): Promise<RunningLog> {
  const host = opts.host ?? "127.0.0.1";
  const server = createServer((req, res) => {
    void logHandler(file, key, opts)(req, res);
  });
  return new Promise((resolve) => {
    server.listen(opts.port, host, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://${host}:${port}/`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

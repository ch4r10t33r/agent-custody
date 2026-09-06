// Where log leaves go.
// The file sink is the local Merkle log, with tree heads signed by the issuer's own key: tamper-evident, but the
// operator holds the file. The HTTP sink hands each leaf to a log run by someone else, who signs the tree head with
// their key. A verifier who trusts that key learns the receipt was in a log the operator cannot rewrite.
// logHandler and serveLog are the other side: a reference log server over node:http, the same code a hosted log runs.
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dsseSign, type Envelope, type KeyPair } from "./crypto.ts";
import { MerkleLog, type InclusionProof } from "./log.ts";
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

function appendSigned(log: MerkleLog, key: KeyPair, leaf: string): LogAppend {
  const e = log.append(leaf);
  const head: TreeHead = { treeSize: e.treeSize, rootHash: e.rootHash, timestamp: new Date().toISOString() };
  return { inclusion: { leafIndex: e.leafIndex, treeSize: e.treeSize, hashes: e.hashes }, treeHead: dsseSign(TREEHEAD_TYPE, head, key) };
}

/** A local JSONL Merkle log. Tree heads are signed with the given key, normally the issuer's own. */
export function fileLog(file: string, key: KeyPair): LogSink {
  const log = new MerkleLog(file);
  return {
    kind: "file",
    where: file,
    async append(leaf) {
      return appendSigned(log, key, leaf);
    },
  };
}

export interface HttpLogOptions {
  /** sent as a bearer token; the log decides what it is worth */
  token?: string;
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
        body: JSON.stringify({ leaf }),
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
  log?: { url: string; tokenEnv?: string | undefined } | undefined;
}

/** The sink a config asks for: a remote log when `log` is set, otherwise the local file. */
export function openLog(cfg: LogConfig, key: KeyPair): LogSink {
  if (cfg.log) {
    const token = cfg.log.tokenEnv ? process.env[cfg.log.tokenEnv] : undefined;
    if (cfg.log.tokenEnv && !token) throw new Error(`log token: environment variable ${cfg.log.tokenEnv} is not set`);
    return httpLog(cfg.log.url, token === undefined ? {} : { token });
  }
  if (!cfg.logFile) throw new Error("config needs logFile or log.url");
  return fileLog(cfg.logFile, key);
}

export interface LogServerOptions {
  /** bearer tokens accepted on append; when empty, anyone may append */
  tokens?: string[];
}

/**
 * The reference log server as a node:http request handler.
 *   POST /append  {leaf}   -> LogAppend, tree head signed with the log's key
 *   GET  /root?size=N      -> {treeSize, rootHash}, for auditors checking a tree head against the log
 */
export function logHandler(file: string, key: KeyPair, opts: LogServerOptions = {}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const log = new MerkleLog(file);
  const tokens = opts.tokens ?? [];
  const authorized = (req: IncomingMessage): boolean => {
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
    if (req.method === "POST" && url.pathname.endsWith("/append")) {
      if (!authorized(req)) return json(401, { error: "unauthorized" });
      let body = "";
      for await (const chunk of req) body += chunk;
      let leaf: unknown;
      try {
        leaf = (JSON.parse(body) as { leaf?: unknown }).leaf;
      } catch {
        return json(400, { error: "body must be JSON {leaf}" });
      }
      if (typeof leaf !== "string" || leaf.length === 0) return json(400, { error: "leaf must be a non-empty string" });
      return json(200, appendSigned(log, key, leaf));
    }
    if (req.method === "GET" && url.pathname.endsWith("/root")) {
      const size = url.searchParams.has("size") ? Number(url.searchParams.get("size")) : log.size;
      if (!Number.isInteger(size) || size < 0 || size > log.size) return json(400, { error: `size must be an integer in 0..${log.size}` });
      return json(200, { treeSize: size, rootHash: log.root(size) });
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

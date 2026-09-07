// The receipt verifier for the browser: the same checks as @agent-custody/receipts' verifyBundle, over WebCrypto.
// Asynchronous because WebCrypto is. No dependencies. Conformance is proven by running it against the published
// vectors in the test next to this file, which is how any second implementation should prove itself.
export interface Envelope { payloadType: string; payload: string; signatures: { keyid: string; sig: string }[] }
export interface Bundle { envelope: Envelope; treeHead: Envelope; inclusion: { leafIndex: number; treeSize: number; hashes: string[] } }
export interface Check { name: string; ok: boolean; detail?: string }
export interface PublicKey { key: CryptoKey; keyid: string; pem: string }
export interface Result { ok: boolean; checks: Check[]; statement: any | null; issuerNote: string | null; treeHeadSigner: "log key" | "issuer key" | null }

const RECEIPT_TYPE = "application/vnd.in-toto+json";
const PREDICATE_TYPE = "https://agent-custody.dev/receipt/v0.2";
const TREEHEAD_TYPE = "application/vnd.agent-custody.treehead+json";
const DELEGATION_TYPE = "application/vnd.agent-custody.delegation+json";
const subtle = () => globalThis.crypto.subtle;

type Bytes = Uint8Array<ArrayBuffer>;
const enc = new TextEncoder();
const b64 = { decode: (s: string): Bytes => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) };
const hex = (buf: ArrayBuffer | Uint8Array) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (h: string): Bytes => Uint8Array.from(h.match(/.{2}/g) ?? [], (x) => parseInt(x, 16));
const concat = (...parts: Bytes[]): Bytes => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const sha256 = async (data: Bytes): Promise<Bytes> => new Uint8Array(await subtle().digest("SHA-256", data));

export function canonicalize(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") { const o: Record<string, unknown> = {}; for (const k of Object.keys(v as object).sort()) { const x = (v as any)[k]; if (x !== undefined) o[k] = sort(x); } return o; }
    return v;
  };
  return JSON.stringify(sort(value));
}
export const digestOf = async (v: unknown) => hex(await sha256(enc.encode(canonicalize(v))));

/** Loads an Ed25519 public key from SPKI PEM. keyid is the sha256 of the DER. */
export async function publicKeyFromPem(pem: string): Promise<PublicKey> {
  const der = b64.decode(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));
  const key = await subtle().importKey("spki", der, { name: "Ed25519" }, true, ["verify"]);
  return { key, keyid: hex(await sha256(der)), pem };
}

function pae(payloadType: string, payload: Bytes): Bytes {
  return concat(enc.encode(`DSSEv1 ${enc.encode(payloadType).length} ${payloadType} ${payload.length} `), payload);
}

export async function dsseVerify(env: Envelope, trusted: PublicKey[]): Promise<{ ok: true; payload: any; keyid: string } | { ok: false; error: string }> {
  if (!env || typeof env.payload !== "string" || !Array.isArray(env.signatures) || env.signatures.length === 0) return { ok: false, error: "malformed envelope" };
  const payload = b64.decode(env.payload);
  const data = pae(env.payloadType, payload);
  for (const s of env.signatures) {
    const key = trusted.find((t) => t.keyid === s.keyid);
    if (!key) continue;
    const good = await subtle().verify({ name: "Ed25519" }, key.key, b64.decode(s.sig), data);
    if (good) { try { return { ok: true, payload: JSON.parse(new TextDecoder().decode(payload)), keyid: s.keyid }; } catch { return { ok: false, error: "payload is not JSON" }; } }
    return { ok: false, error: `signature by ${s.keyid.slice(0, 12)} did not verify` };
  }
  return { ok: false, error: `no trusted key matches keyids [${env.signatures.map((s) => s.keyid.slice(0, 12)).join(", ")}]` };
}

// ---- RFC 6962 / 9162 ----
const leafHash = (data: string) => sha256(concat(new Uint8Array([0]), enc.encode(data)));
const nodeHash = (l: Bytes, r: Bytes) => sha256(concat(new Uint8Array([1]), l, r));
export async function verifyInclusion(leaf: Bytes, proof: Bundle["inclusion"], rootHex: string): Promise<boolean> {
  let fn = proof.leafIndex, sn = proof.treeSize - 1;
  if (fn < 0 || sn < 0 || fn > sn) return false;
  let r = leaf;
  for (const h of proof.hashes) {
    if (sn === 0) return false;
    const p = unhex(h);
    if (fn % 2 === 1 || fn === sn) { r = await nodeHash(p, r); if (fn % 2 === 0) { while (fn % 2 === 0 && fn !== 0) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); } } }
    else r = await nodeHash(r, p);
    fn = Math.floor(fn / 2); sn = Math.floor(sn / 2);
  }
  return sn === 0 && hex(r) === rootHex;
}
export async function verifyConsistency(oldSize: number, oldRoot: string, newSize: number, newRoot: string, proofHex: string[]): Promise<boolean> {
  if (oldSize < 0 || oldSize > newSize) return false;
  if (oldSize === newSize) return proofHex.length === 0 && oldRoot === newRoot;
  if (oldSize === 0) return proofHex.length === 0;
  if (proofHex.length === 0) return false;
  const proof = proofHex.map(unhex);
  if ((oldSize & (oldSize - 1)) === 0) proof.unshift(unhex(oldRoot));
  let fn = oldSize - 1, sn = newSize - 1;
  while (fn % 2 === 1) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
  let fr = proof[0]!, sr = proof[0]!;
  for (const c of proof.slice(1)) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) { fr = await nodeHash(c, fr); sr = await nodeHash(c, sr); while (fn % 2 === 0 && fn !== 0) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); } }
    else sr = await nodeHash(sr, c);
    fn = Math.floor(fn / 2); sn = Math.floor(sn / 2);
  }
  return sn === 0 && hex(fr) === oldRoot && hex(sr) === newRoot;
}

const ISSUER_NOTE: Record<string, string> = {
  gateway: "enforced outside the agent's process; the agent could neither skip nor forge this receipt",
  sdk: "self-reported by the agent's own process; tamper-evident after issue, but nothing here was enforced outside the agent",
};
const short = (s: string) => s.slice(0, 12);

export interface Options { issuerKeys: PublicKey[]; principalKeys: PublicKey[]; logKeys?: PublicKey[]; logLeaves?: string[] }

/** The same checks, in the same order, with the same names, as the reference verifyBundle. */
export async function verifyBundle(bundle: Bundle, opts: Options): Promise<Result> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail?: string) => { checks.push(detail === undefined ? { name, ok } : { name, ok, detail }); return ok; };
  let treeHeadSigner: Result["treeHeadSigner"] = null;
  const done = (statement: any | null): Result => ({ ok: checks.every((c) => c.ok), checks, statement, issuerNote: statement ? (ISSUER_NOTE[statement.predicate.issuer.kind] ?? "unknown issuer kind") : null, treeHeadSigner });

  const sig = await dsseVerify(bundle.envelope, opts.issuerKeys);
  if (!sig.ok) { add("receipt signature (issuer key)", false, sig.error); return done(null); }
  add("receipt signature (issuer key)", true, `keyid ${short(sig.keyid)}`);
  const st = sig.payload;
  if (!add("receipt payload type", bundle.envelope.payloadType === RECEIPT_TYPE && st.predicateType === PREDICATE_TYPE)) return done(null);
  const p = st.predicate;
  add("issuer kind is known", p.issuer.kind === "gateway" || p.issuer.kind === "sdk", `${p.issuer.kind}${p.issuer.framework ? ` / ${p.issuer.framework}` : ""}`);
  add("issuer keyid matches signer", p.issuer.keyid === sig.keyid);
  if (p.issuer.kind === "gateway") {
    add("gateway receipt carries a delegation", p.delegation !== undefined);
    add("gateway receipt carries a policy decision", p.policy !== null);
  }
  if (p.delegation) {
    const del = await dsseVerify(p.delegation.envelope, opts.principalKeys);
    const d = del.ok ? del.payload : null;
    const shape = d && d.version === "0.1" && typeof d.principal === "string" && typeof d.agent === "string" && Array.isArray(d.scopes) && typeof d.issuedAt === "string" && typeof d.expiresAt === "string";
    add("delegation signature (principal key)", del.ok && p.delegation.envelope.payloadType === DELEGATION_TYPE && shape, del.ok ? (shape ? `signed by ${short(del.keyid)}` : "malformed delegation") : del.error);
    if (del.ok && shape) {
      const principalKeyid = p.principal.provenance === "attested" ? p.principal.keyid : null;
      add("delegation binds principal and agent", d.principal === p.principal.id && d.agent === p.agent.id && del.keyid === principalKeyid);
      add("delegation valid at receipt time", d.issuedAt <= p.timestamp && p.timestamp <= d.expiresAt, `${d.issuedAt} .. ${d.expiresAt}`);
      const inScope = d.scopes.includes(p.tool.name);
      const executed = p.execution.status === "executed" || p.execution.status === "failed";
      add("executed tool within delegated scope", !executed || inScope, inScope ? p.tool.name : `${p.tool.name} not in [${d.scopes.join(", ")}]`);
    }
  } else {
    add("principal is claimed, not attested", p.principal.provenance === "claimed", "no signed delegation in this receipt");
  }
  const argsDigest = await digestOf(p.request.args);
  add("request args digest", argsDigest === p.request.argsDigest && st.subject[0]?.digest.sha256 === p.request.argsDigest);
  if (p.policy) {
    const consistent = p.policy.decision === "allow" ? p.execution.status !== "denied" : p.execution.status === "denied";
    add("policy decision consistent with execution", consistent, `${p.policy.decision} -> ${p.execution.status}`);
    add("no policy errors on an allow", !(p.policy.decision === "allow" && p.policy.errors.length > 0));
  }
  const logKeys = opts.logKeys ?? [];
  const th = await dsseVerify(bundle.treeHead, [...logKeys, ...opts.issuerKeys]);
  const byLog = th.ok && logKeys.some((k) => k.keyid === th.keyid);
  treeHeadSigner = th.ok ? (byLog ? "log key" : "issuer key") : null;
  add("tree head signature", th.ok && bundle.treeHead.payloadType === TREEHEAD_TYPE, th.ok ? `${byLog ? "log key" : "issuer key"} ${short(th.keyid)}` : th.error);
  if (th.ok) {
    const head = th.payload;
    add("tree head matches inclusion proof size", head.treeSize === bundle.inclusion.treeSize);
    const included = await verifyInclusion(await leafHash(canonicalize(bundle.envelope)), bundle.inclusion, head.rootHash);
    add("log inclusion proof", included, `leaf ${bundle.inclusion.leafIndex} of ${bundle.inclusion.treeSize}, root ${short(head.rootHash)}`);
    if (opts.logLeaves) {
      const hashes: Bytes[] = [];
      for (const l of opts.logLeaves) hashes.push(await leafHash(l));
      if (head.treeSize > hashes.length) add("log file root matches tree head", false, `log copy has ${hashes.length} leaves, tree head is at ${head.treeSize}`);
      else { const root = await rootOf(hashes, head.treeSize); add("log file root matches tree head", root === head.rootHash, `recomputed ${short(root)}`); }
    }
  }
  return done(st);
}

async function rootOf(hashes: Bytes[], size: number): Promise<string> {
  const split = (n: number) => { let k = 1; while (k * 2 < n) k *= 2; return k; };
  const mth = async (lo: number, hi: number): Promise<Bytes> => {
    const n = hi - lo;
    if (n === 0) return sha256(new Uint8Array(0));
    if (n === 1) return hashes[lo]!;
    const k = split(n);
    return nodeHash(await mth(lo, lo + k), await mth(lo + k, hi));
  };
  return hex(await mth(0, size));
}

export interface AuditResult { ok: boolean; checks: Check[] }
export async function auditExtends(older: Envelope, newer: Envelope, proof: string[], keys: PublicKey[]): Promise<AuditResult> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail?: string) => { checks.push(detail === undefined ? { name, ok } : { name, ok, detail }); return ok; };
  const decode = async (label: string, env: Envelope) => { const v = await dsseVerify(env, keys); add(`${label} tree head signature`, v.ok && env.payloadType === TREEHEAD_TYPE, v.ok ? `keyid ${short(v.keyid)}` : v.error); return v.ok ? v.payload : null; };
  const a = await decode("older", older);
  const b = await decode("newer", newer);
  if (!a || !b) return { ok: false, checks };
  if (!add("older is not larger than newer", a.treeSize <= b.treeSize, `${a.treeSize} -> ${b.treeSize}`)) return { ok: false, checks };
  const consistent = await verifyConsistency(a.treeSize, a.rootHash, b.treeSize, b.rootHash, proof);
  add("newer log extends older log", consistent, consistent ? `${proof.length} proof hashes` : "history was rewritten, or the proof is for other tree heads");
  return { ok: checks.every((c) => c.ok), checks };
}

/** The human-readable report, the same shape the CLI prints. */
export function formatReport(r: Result): string {
  const lines = r.checks.map((c) => `${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
  lines.push("", r.ok ? "RESULT: VERIFIED" : "RESULT: NOT VERIFIED");
  if (!r.statement) return lines.join("\n");
  const p = r.statement.predicate;
  lines.push("", `ISSUER: ${p.issuer.kind}${p.issuer.framework ? ` (${p.issuer.framework})` : ""}, ${r.issuerNote}`, "", "field           provenance  value");
  const row = (f: string, prov: string, v: unknown) => lines.push(`${f.padEnd(15)} ${prov.padEnd(11)} ${typeof v === "string" ? v : JSON.stringify(v)}`);
  row("principal", p.principal.provenance, p.principal.id ?? "(none)");
  row("agent", p.agent.provenance, p.agent.id);
  if (p.session.id || p.session.toolUseId) row("session", p.session.provenance, `${p.session.id ?? "-"} / ${p.session.toolUseId ?? "-"}`);
  row("model", p.model.provenance, p.model.id ?? "(none supplied)");
  row("tool", p.tool.provenance, p.tool.name);
  row("args", p.request.provenance, p.request.args);
  for (const [k, f] of Object.entries<any>(p.facts)) row(`fact.${k}`, f.provenance, f.value);
  if (p.policy) row("policy", p.policy.provenance, `${p.policy.decision} [${p.policy.reasons.join(",")}] policy ${short(p.policy.policyDigest)}`); else row("policy", "-", "(none evaluated)");
  if (p.consumed) row("consumed", p.consumed.provenance, p.consumed.factIds.length === 0 ? "(no facts shown before this call)" : p.consumed.factIds);
  row("execution", p.execution.provenance, p.execution.status);
  return lines.join("\n");
}

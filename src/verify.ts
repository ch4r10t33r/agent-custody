// Independent verification of a receipt bundle. Needs only public keys, and optionally a copy of the log.
import { canonicalize, digestOf, dsseVerify, type PublicKeyRef } from "./crypto.ts";
import { delegationValidAt, verifyDelegation } from "./delegation.ts";
import { leafHash, MerkleLog, verifyInclusion } from "./log.ts";
import { RECEIPT_PREDICATE_TYPE, RECEIPT_TYPE, TREEHEAD_TYPE, type ReceiptBundle, type ReceiptStatement, type TreeHead } from "./receipt.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface VerifyOptions {
  gatewayKeys: PublicKeyRef[];
  principalKeys: PublicKeyRef[];
  /** If given, the root is recomputed from this log file at the receipt's tree size and compared. */
  logFile?: string;
}

export interface VerifyResult {
  ok: boolean;
  checks: Check[];
  statement: ReceiptStatement | null;
}

const short = (s: string) => s.slice(0, 12);

export function verifyBundle(bundle: ReceiptBundle, opts: VerifyOptions): VerifyResult {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail?: string) => {
    checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
    return ok;
  };
  const done = (statement: ReceiptStatement | null): VerifyResult => ({ ok: checks.every((c) => c.ok), checks, statement });

  const sig = dsseVerify(bundle.envelope, opts.gatewayKeys);
  if (!sig.ok) {
    add("receipt signature (gateway key)", false, sig.error);
    return done(null);
  }
  add("receipt signature (gateway key)", true, `keyid ${short(sig.keyid)}`);
  const st = sig.payload as ReceiptStatement;
  if (!add("receipt payload type", bundle.envelope.payloadType === RECEIPT_TYPE && st.predicateType === RECEIPT_PREDICATE_TYPE)) return done(null);
  const p = st.predicate;

  add("gateway keyid matches signer", p.gateway.keyid === sig.keyid);

  const del = verifyDelegation(p.delegation.envelope, opts.principalKeys);
  add("delegation signature (principal key)", del.ok, del.ok ? `signed by ${short(del.keyid)}` : del.error);
  if (del.ok) {
    const d = del.delegation;
    add("delegation binds principal and agent", d.principal === p.principal.id && d.agent === p.agent.id && del.keyid === p.principal.keyid);
    add("delegation valid at receipt time", delegationValidAt(d, p.timestamp), `${d.issuedAt} .. ${d.expiresAt}`);
    const inScope = d.scopes.includes(p.tool.name);
    const executed = p.execution.status === "executed" || p.execution.status === "failed";
    add("executed tool within delegated scope", !executed || inScope, inScope ? p.tool.name : `${p.tool.name} not in [${d.scopes.join(", ")}]`);
  }

  add("request args digest", digestOf(p.request.args) === p.request.argsDigest && st.subject[0]?.digest.sha256 === p.request.argsDigest);
  const consistent = p.policy.decision === "allow" ? p.execution.status !== "denied" : p.execution.status === "denied";
  add("policy decision consistent with execution", consistent, `${p.policy.decision} -> ${p.execution.status}`);
  add("no policy errors on an allow", !(p.policy.decision === "allow" && p.policy.errors.length > 0));

  const th = dsseVerify(bundle.treeHead, opts.gatewayKeys);
  add("tree head signature", th.ok && bundle.treeHead.payloadType === TREEHEAD_TYPE, th.ok ? undefined : th.error);
  if (th.ok) {
    const head = th.payload as TreeHead;
    add("tree head matches inclusion proof size", head.treeSize === bundle.inclusion.treeSize);
    const included = verifyInclusion(leafHash(canonicalize(bundle.envelope)), bundle.inclusion, head.rootHash);
    add("log inclusion proof", included, `leaf ${bundle.inclusion.leafIndex} of ${bundle.inclusion.treeSize}, root ${short(head.rootHash)}`);
    if (opts.logFile) {
      let root = "";
      try {
        root = MerkleLog.rootFromFile(opts.logFile, head.treeSize);
      } catch (e) {
        add("log file root matches tree head", false, String(e instanceof Error ? e.message : e));
      }
      if (root) add("log file root matches tree head", root === head.rootHash, `recomputed ${short(root)}`);
    }
  }
  return done(st);
}

/** Human-readable report: checks, then every field with its provenance so the reader knows what was proven vs. claimed. */
export function formatReport(r: VerifyResult): string {
  const lines: string[] = [];
  for (const c of r.checks) lines.push(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
  lines.push("");
  lines.push(r.ok ? "RESULT: VERIFIED" : "RESULT: NOT VERIFIED");
  if (!r.statement) return lines.join("\n");
  const p = r.statement.predicate;
  lines.push("");
  lines.push("field           provenance  value");
  const row = (f: string, prov: string, v: unknown) => lines.push(`${f.padEnd(15)} ${prov.padEnd(11)} ${typeof v === "string" ? v : JSON.stringify(v)}`);
  row("principal", p.principal.provenance, p.principal.id);
  row("agent", p.agent.provenance, p.agent.id);
  row("model", p.model.provenance, p.model.id ?? "(none supplied)");
  row("tool", p.tool.provenance, p.tool.name);
  row("args", p.request.provenance, p.request.args);
  for (const [k, f] of Object.entries(p.facts)) row(`fact.${k}`, f.provenance, f.value);
  row("policy", p.policy.provenance, `${p.policy.decision} [${p.policy.reasons.join(",")}] policy ${short(p.policy.policyDigest)}`);
  row("execution", p.execution.provenance, p.execution.status);
  return lines.join("\n");
}

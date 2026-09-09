// A tenant's export of their own log: every leaf hash, the signed head, the published keys, the signed checkpoints,
// and their metering, fetched with their own token and written as files they can keep. The leaves go into a log
// file in the format the verifier already reads, so `verify --log` and `audit --log` work against the export with
// no server at all. The export checks itself before it is written: the head must verify against the published keys
// and its root must be the root of the leaves fetched, and the same for every checkpoint. A tenant who leaves takes
// this with them; a tenant who stays runs it on a schedule so the evidence never depends on one operator.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dsseVerify, type Envelope } from "./crypto.ts";
import { rootOf } from "./log.ts";
import { TREEHEAD_TYPE, type TreeHead } from "./receipt.ts";
import { fetchLogKeys, type KeyDocument } from "./signer.ts";

export interface ExportOptions {
  logUrl: string;
  /** the tenant whose log to export; omitted, the log at the root paths */
  tenant?: string | undefined;
  token: string;
  outDir: string;
  /** months of usage to include, YYYY-MM; default the current and the previous month */
  months?: string[] | undefined;
  fetch?: typeof fetch;
}

export interface ExportResult {
  outDir: string;
  logId: string | null;
  treeSize: number;
  rootHash: string;
  keyid: string;
  checkpoints: number;
  /** administrative actions on this tenant: tokens minted and revoked, the tenant created or disabled, by whom */
  audit: number;
  usage: { month: string; appends: number; totalLeaves: number; liveTokens: number }[];
  /** what did not add up; an export with problems is still written, and says so */
  problems: string[];
}

const monthOf = (d: Date) => d.toISOString().slice(0, 7);
const previousMonth = (d: Date) => monthOf(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)));

export async function exportLog(o: ExportOptions): Promise<ExportResult> {
  const f = o.fetch ?? fetch;
  const base = o.logUrl.endsWith("/") ? o.logUrl : `${o.logUrl}/`;
  const path = (op: string) => new URL(o.tenant ? `t/${o.tenant}/${op}` : op, base);
  const headers = { authorization: `Bearer ${o.token}` };
  const get = async (url: URL, auth: boolean): Promise<unknown> => {
    const res = await f(url, { signal: AbortSignal.timeout(30_000), ...(auth ? { headers } : {}) });
    if (res.status === 401) throw new Error(`the log refused the token for ${url.pathname}`);
    if (!res.ok) throw new Error(`${res.status} from ${url.pathname}`);
    return res.json();
  };
  const problems: string[] = [];

  const { doc, keys } = await fetchLogKeys(base, f);
  const { treeHead } = (await get(path("head"), false)) as { treeHead: Envelope };
  const v = dsseVerify(treeHead, keys);
  if (!v.ok || treeHead.payloadType !== TREEHEAD_TYPE) throw new Error(`the head does not verify against the published keys: ${v.ok ? "not a tree head" : v.error}`);
  const head = v.payload as TreeHead;

  // every leaf, in pages, as of the head's size; leaves appended meanwhile are the next export's
  const leaves: string[] = [];
  while (leaves.length < head.treeSize) {
    const page = (await get(new URL(`?since=${leaves.length}&limit=10000`, path("leaves")), true)) as { leaves: string[] };
    if (page.leaves.length === 0) throw new Error(`the log returned no leaves past ${leaves.length} of ${head.treeSize}`);
    leaves.push(...page.leaves.slice(0, head.treeSize - leaves.length));
  }
  const hashes = leaves.map((h) => Buffer.from(h, "hex"));
  const root = rootOf(hashes);
  if (root !== head.rootHash) problems.push(`the root of the ${leaves.length} leaves fetched (${root.slice(0, 12)}) is not the head's (${head.rootHash.slice(0, 12)})`);

  const cps = (await get(path("checkpoints"), false)) as { checkpoints: { treeSize: number; rootHash: string; signedAt: string; treeHead: Envelope }[] };
  for (const c of cps.checkpoints) {
    const cv = dsseVerify(c.treeHead, keys);
    if (!cv.ok) problems.push(`checkpoint at ${c.treeSize} does not verify: ${cv.error}`);
    else if (c.treeSize <= head.treeSize && rootOf(hashes, c.treeSize) !== c.rootHash) problems.push(`checkpoint at ${c.treeSize} has root ${c.rootHash.slice(0, 12)}, the leaves give ${rootOf(hashes, c.treeSize).slice(0, 12)}`);
  }

  const usage: ExportResult["usage"] = [];
  for (const month of o.months ?? [monthOf(new Date()), previousMonth(new Date())]) {
    try {
      usage.push((await get(new URL(`?month=${month}`, path("usage")), true)) as ExportResult["usage"][number]);
    } catch (e) {
      problems.push(`usage for ${month}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let audit: unknown[] = [];
  try {
    audit = ((await get(new URL("?limit=1000", path("audit")), true)) as { entries: unknown[] }).entries;
  } catch (e) {
    problems.push(`audit trail: ${e instanceof Error ? e.message : String(e)}`);
  }

  mkdirSync(o.outDir, { recursive: true });
  writeFileSync(join(o.outDir, "log.jsonl"), leaves.map((h) => JSON.stringify({ hash: h })).join("\n") + (leaves.length ? "\n" : ""));
  writeFileSync(join(o.outDir, "head.json"), JSON.stringify({ treeHead, ...head }, null, 2));
  writeFileSync(join(o.outDir, "keys.json"), JSON.stringify(doc satisfies KeyDocument, null, 2));
  writeFileSync(join(o.outDir, "checkpoints.json"), JSON.stringify(cps.checkpoints, null, 2));
  writeFileSync(join(o.outDir, "usage.json"), JSON.stringify(usage, null, 2));
  writeFileSync(join(o.outDir, "audit.json"), JSON.stringify(audit, null, 2));
  const result: ExportResult = { outDir: o.outDir, logId: head.log ?? null, treeSize: head.treeSize, rootHash: head.rootHash, keyid: v.keyid, checkpoints: cps.checkpoints.length, audit: audit.length, usage, problems };
  writeFileSync(join(o.outDir, "export.json"), JSON.stringify({ exportedAt: new Date().toISOString(), logUrl: base, tenant: o.tenant ?? null, ...result }, null, 2));
  return result;
}

export function formatExport(r: ExportResult): string {
  const lines = [
    `exported ${r.treeSize} leaf hash(es) of log ${r.logId ?? "(unnamed)"} to ${r.outDir}`,
    `head root ${r.rootHash.slice(0, 16)}, signed by ${r.keyid.slice(0, 12)}, ${r.checkpoints} checkpoint(s), ${r.audit} administrative action(s) on this tenant`,
    ...r.usage.map((u) => `usage ${u.month}: ${u.appends} append(s), ${u.totalLeaves} leaves in total, ${u.liveTokens} live token(s)`),
    "",
    "log.jsonl is a log copy the verifier reads: agent-custody verify <receipt> --log <outDir>/log.jsonl --issuer-key ...",
    ...(r.problems.length ? ["", ...r.problems.map((p) => `PROBLEM: ${p}`), "", "RESULT: EXPORT DOES NOT ADD UP"] : ["", "RESULT: EXPORT VERIFIED"]),
  ];
  return lines.join("\n");
}

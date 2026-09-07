// Scenario files and signed eval reports. A team encodes its own memory incidents as scenarios, runs them on a
// schedule, and hands a reviewer a report signed with a key, verifiable with the same envelope format as receipts.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { digestOf, dsseSign, dsseVerify, type Envelope, type KeyPair, type PublicKeyRef } from "@agent-custody/receipts";
import type { Report, Scenario } from "./evals.ts";

export const EVAL_REPORT_TYPE = "https://agent-custody.dev/eval-report/v0.1";

const OpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("write"), key: z.string().min(1), subject: z.string().min(1), predicate: z.string().min(1), value: z.unknown(), space: z.string().min(1).optional(), actor: z.string().min(1).optional(), supersedes: z.string().min(1).optional(), bad: z.boolean().optional() }),
  z.object({ op: z.literal("read"), subject: z.string().min(1), predicate: z.string().min(1).optional(), space: z.string().min(1).optional(), expect: z.unknown() }),
  z.object({ op: z.literal("retract"), key: z.string().min(1), actor: z.string().min(1).optional(), reason: z.string().min(1).optional() }),
]);
export const ScenarioFileSchema = z.object({
  version: z.literal("0.1"),
  scenarios: z.array(z.object({ name: z.string().min(1), ops: z.array(OpSchema).min(1) })).min(1),
});
export type ScenarioFile = z.infer<typeof ScenarioFileSchema>;

/** Loads and validates a scenario file. Every read must carry `expect`, null meaning "nothing". */
export function loadScenarios(path: string): Scenario[] {
  const parsed = ScenarioFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`scenario file ${path}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  for (const [si, s] of parsed.data.scenarios.entries()) for (const [oi, o] of s.ops.entries()) if (o.op === "read" && !("expect" in o)) throw new Error(`scenario file ${path}: scenarios.${si}.ops.${oi}: a read needs expect (null for nothing)`);
  return parsed.data.scenarios as Scenario[];
}

export interface EvalReportPredicate {
  system: string;
  scenariosDigest: string;
  scenarioNames: string[];
  report: Report;
  ranAt: string;
}

/** An in-toto statement over the report, signed with the given key: the artefact a reviewer verifies. */
export function signReport(system: string, scenarios: Scenario[], report: Report, key: KeyPair): Envelope {
  const predicate: EvalReportPredicate = { system, scenariosDigest: digestOf(scenarios), scenarioNames: scenarios.map((s) => s.name), report, ranAt: new Date().toISOString() };
  const statement = { _type: "https://in-toto.io/Statement/v1", subject: [{ name: `eval:${system}`, digest: { sha256: digestOf(report) } }], predicateType: EVAL_REPORT_TYPE, predicate };
  return dsseSign("application/vnd.in-toto+json", statement, key);
}

export type ReportCheck = { ok: true; predicate: EvalReportPredicate; keyid: string } | { ok: false; error: string };

export function verifyReport(envelope: Envelope, keys: PublicKeyRef[]): ReportCheck {
  const v = dsseVerify(envelope, keys);
  if (!v.ok) return { ok: false, error: v.error };
  const st = v.payload as { predicateType?: string; subject?: { digest?: { sha256?: string } }[]; predicate?: EvalReportPredicate };
  if (st.predicateType !== EVAL_REPORT_TYPE || !st.predicate) return { ok: false, error: `not an eval report: ${String(st.predicateType)}` };
  if (st.subject?.[0]?.digest?.sha256 !== digestOf(st.predicate.report)) return { ok: false, error: "report digest does not match the subject" };
  return { ok: true, predicate: st.predicate, keyid: v.keyid };
}

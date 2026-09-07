// A team's own incidents as a file, and a report a reviewer can verify. Both must fail loudly when malformed.
import { mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateKeyPair, writeKeyPair } from "@agent-custody/receipts";
import { runAll, SCENARIOS } from "../src/evals.ts";
import { loadScenarios, signReport, verifyReport } from "../src/evals-file.ts";
import { ledgerUnderTest } from "../src/evals-ledger.ts";
import { Ledger } from "../src/ledger.ts";

const dir = () => mkdtempSync(join(tmpdir(), "evals-file-"));
const cli = (args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, "..", "src", "cli.ts"), ...args], { encoding: "utf8", timeout: 60_000 });

describe("scenario files and signed reports", () => {
  it("a valid file round-trips, and an invalid one names the problem", () => {
    const d = dir();
    writeFileSync(join(d, "ok.json"), JSON.stringify({ version: "0.1", scenarios: [{ name: "mine", ops: [{ op: "write", key: "a", subject: "s", predicate: "p", value: 1 }, { op: "read", subject: "s", predicate: "p", expect: 1 }] }] }));
    expect(loadScenarios(join(d, "ok.json")).map((s) => s.name)).toEqual(["mine"]);
    writeFileSync(join(d, "bad.json"), JSON.stringify({ version: "0.1", scenarios: [{ name: "x", ops: [{ op: "read", subject: "s" }] }] }));
    expect(() => loadScenarios(join(d, "bad.json"))).toThrow(/expect/);
    writeFileSync(join(d, "bad2.json"), JSON.stringify({ version: "0.1", scenarios: [{ name: "x", ops: [{ op: "fly" }] }] }));
    expect(() => loadScenarios(join(d, "bad2.json"))).toThrow(/scenarios\.0\.ops\.0/);
  });

  it("a signed report verifies with the key, binds to its scenarios, and fails when edited", async () => {
    const kp = generateKeyPair();
    const report = await runAll(ledgerUnderTest(new Ledger(join(dir(), "l.jsonl"))), SCENARIOS);
    const env = signReport("ledger", SCENARIOS, report, kp);
    const ok = verifyReport(env, [kp]);
    expect(ok.ok && ok.predicate.report.totals.correctReads).toBe(report.totals.reads);
    expect(ok.ok && ok.predicate.scenarioNames.length).toBe(SCENARIOS.length);
    expect(verifyReport(env, [generateKeyPair()]).ok).toBe(false);
    const tampered = { ...env, payload: env.payload.replace(/^(.)/, (c) => (c === "A" ? "B" : "A")) };
    expect(verifyReport(tampered, [kp]).ok).toBe(false);
  });

  it("the CLI runs the built-in scenarios, scores the baseline, signs a report, and verifies it", () => {
    const d = dir();
    const key = writeKeyPair(generateKeyPair(), join(d, "keys"), "eval");
    const run = cli(["eval", "--baseline", "--json", "--sign", key.keyFile, "--out", join(d, "report.json")]);
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout);
    expect(out.ledger.totals.correctReads).toBe(out.ledger.totals.reads);
    expect(out.baseline.totals.correctReads).toBeLessThan(out.baseline.totals.reads);
    const v = cli(["eval", "--verify", join(d, "report.json"), "--key", key.pubFile]);
    expect(v.status, v.stderr).toBe(0);
    expect(v.stdout).toMatch(/^VERIFIED/);
    const other = writeKeyPair(generateKeyPair(), join(d, "keys"), "other");
    const wrong = cli(["eval", "--verify", join(d, "report.json"), "--key", other.pubFile]);
    expect(wrong.status).toBe(1);
    expect(wrong.stdout).toMatch(/^NOT VERIFIED/);
  });

  it("the CLI exits 1 when a custom scenario fails on the ledger", () => {
    const d = dir();
    writeFileSync(join(d, "wrong.json"), JSON.stringify({ version: "0.1", scenarios: [{ name: "expects the impossible", ops: [{ op: "write", key: "a", subject: "s", predicate: "p", value: 1 }, { op: "read", subject: "s", predicate: "p", expect: 2 }] }] }));
    const run = cli(["eval", "--scenarios", join(d, "wrong.json"), "--json"]);
    expect(run.status).toBe(1);
    expect(JSON.parse(run.stdout).ledger.totals.staleReads).toBe(1);
  });
});

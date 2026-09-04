// Every examples/NN-*.ts file must run to completion and end with "OK". This is what keeps the tutorials true.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const dir = resolve(import.meta.dirname, "..", "examples");
const files = readdirSync(dir).filter((f) => /^\d\d-.*\.ts$/.test(f)).sort();

describe("examples", () => {
  it("exist", () => expect(files.length).toBeGreaterThanOrEqual(12));
  for (const f of files) {
    it(f, () => {
      const r = spawnSync(process.execPath, ["--import", "tsx", join(dir, f)], { encoding: "utf8", timeout: 90_000, env: { ...process.env, OPENAI_AGENTS_DISABLE_TRACING: "1" } });
      expect(r.status, `${f}\n${r.stderr}`).toBe(0);
      expect(r.stdout.trim().endsWith("OK"), `${f} did not end with OK:\n${r.stdout.slice(-400)}`).toBe(true);
    }, 100_000);
  }
});

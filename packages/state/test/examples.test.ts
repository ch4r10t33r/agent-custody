// Every examples/NN-*.ts file must run to completion on plain Node and end with "OK". This is what keeps the README true.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const dir = resolve(import.meta.dirname, "..", "examples");
const files = readdirSync(dir).filter((f) => /^\d\d-.*\.ts$/.test(f)).sort();

describe("examples", () => {
  it("exist", () => expect(files.length).toBeGreaterThanOrEqual(1));
  for (const f of files) {
    it(f, () => {
      const r = spawnSync(process.execPath, [join(dir, f)], { encoding: "utf8", timeout: 60_000 });
      expect(r.status, `${f}\n${r.stderr}`).toBe(0);
      expect(r.stdout.trim().endsWith("OK"), `${f} did not end with OK:\n${r.stdout.slice(-400)}`).toBe(true);
    }, 70_000);
  }
});

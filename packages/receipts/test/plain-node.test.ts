// The CLI, the fake upstreams, and anything the state package spawns run on plain Node with native type stripping,
// which rejects TypeScript-only runtime syntax such as parameter properties and enums. This loads every source module
// under plain Node so that kind of regression fails here, not in a spawned process three packages away.
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const src = resolve(import.meta.dirname, "..", "src");
const files: string[] = [];
const walk = (d: string) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith(".ts") && f !== "cli.ts") files.push(p);
  }
};
walk(src);

describe("every source module loads under plain Node", () => {
  it("finds the modules", () => expect(files.length).toBeGreaterThan(10));
  for (const f of files) {
    it(f.slice(src.length + 1), () => {
      const r = spawnSync(process.execPath, ["-e", `import(${JSON.stringify(f)}).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); })`], { encoding: "utf8", timeout: 30_000 });
      expect(r.status, r.stderr).toBe(0);
    });
  }
});

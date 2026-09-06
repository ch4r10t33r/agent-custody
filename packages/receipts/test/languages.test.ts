// Each language example is a client of the sidecar. Every one whose toolchain is installed runs against a live sidecar
// and must print OK. A missing toolchain skips that language, visibly, rather than pretending it passed.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSdkFixture, type SdkFixture } from "../scripts/fixture.ts";

const dir = resolve(import.meta.dirname, "..", "examples", "languages");
const has = (bin: string) => spawnSync("which", [bin]).status === 0;

const languages: { name: string; bin: string; cmd: string[]; cwd: string }[] = [
  { name: "python", bin: "python3", cmd: ["python3", "main.py"], cwd: join(dir, "python") },
  { name: "go", bin: "go", cmd: ["go", "run", "."], cwd: join(dir, "go") },
  { name: "java", bin: "java", cmd: ["java", "Receipt.java"], cwd: join(dir, "java") },
  { name: "rust", bin: "cargo", cmd: ["cargo", "run", "--quiet"], cwd: join(dir, "rust") },
];

describe("language examples against the sidecar", () => {
  let fx: SdkFixture;
  let side: ChildProcess;
  let url = "";
  // The sidecar runs as its own process, the way it does in production. The examples are run synchronously, which
  // would block an in-process sidecar and hang every client.
  beforeAll(async () => {
    fx = buildSdkFixture(mkdtempSync(join(tmpdir(), "languages-")));
    side = spawn(process.execPath, [resolve(import.meta.dirname, "..", "src", "cli.ts"), "serve", "--config", fx.configFile, "--port", "0"]);
    url = await new Promise<string>((res, rej) => {
      side.stderr!.on("data", (d) => {
        const m = /(http:\/\/[^ ]+)/.exec(String(d));
        if (m) res(m[1]!);
      });
      side.on("exit", (code) => rej(new Error(`sidecar exited with ${code}`)));
    });
  });
  afterAll(() => {
    side.kill();
  });

  for (const l of languages) {
    const run = has(l.bin) ? it : it.skip;
    run(`${l.name}${has(l.bin) ? "" : ` (skipped: ${l.bin} not installed)`}`, () => {
      const before = readdirSync(fx.receiptsDir).length;
      const r = spawnSync(l.cmd[0]!, l.cmd.slice(1), { cwd: l.cwd, encoding: "utf8", timeout: 240_000, env: { ...process.env, SIDECAR_URL: url } });
      expect(r.status, `${l.name}\n${r.stderr}`).toBe(0);
      expect(r.stdout.trim().endsWith("OK"), `${l.name} did not end with OK:\n${r.stdout.slice(-400)}`).toBe(true);
      expect(readdirSync(fx.receiptsDir).length).toBe(before + 1);
    }, 250_000);
  }
});

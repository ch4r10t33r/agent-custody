// The ledger must behave identically on JSONL and SQLite. The whole ledger suite runs against both through the
// factory below; this file adds what differs: durability, in-place forget with no value left in the file, a second
// process seeing appends, and export back to the auditable JSONL.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger.ts";
import { JsonlStore, SqliteStore, openStore } from "../src/storage.ts";

const dir = () => mkdtempSync(join(tmpdir(), "storage-"));

describe("storage backends", () => {
  it("openStore picks SQLite by extension and JSONL otherwise", () => {
    const d = dir();
    expect(openStore(join(d, "a.jsonl")).kind).toBe("jsonl");
    expect(openStore(join(d, "b.sqlite")).kind).toBe("sqlite");
    expect(openStore(join(d, "c.db")).kind).toBe("sqlite");
  });

  for (const [name, ext] of [["jsonl", "ledger.jsonl"], ["sqlite", "ledger.sqlite"]] as const) {
    describe(name, () => {
      it("survives reopening with the same beliefs and the same history", () => {
        const f = join(dir(), ext);
        const l = new Ledger(f);
        const a = l.assert({ subject: "s", predicate: "p", value: 1, space: "org", actor: "x" });
        l.assert({ subject: "s", predicate: "p", value: 2, space: "org", actor: "y", supersedes: a.fact.factId });
        l.hold({ factId: a.fact.factId, actor: "legal", reason: "r" });
        l.close();
        const again = new Ledger(f);
        expect(again.size).toBe(3);
        expect(again.asOf().map((x) => x.value)).toEqual([2]);
        expect(again.history(a.fact.factId).map((e) => e.kind)).toEqual(["assert", "assert", "hold"]);
        expect(again.held(a.fact.factId)).toBe(true);
        again.close();
      });

      it("forget leaves no copy of the value in the file, and the export carries the tombstone", () => {
        const f = join(dir(), ext);
        const l = new Ledger(f);
        const secret = l.assert({ subject: "p:1", predicate: "ssn", value: "SSN-987-65-4321", space: "org", actor: "x" });
        l.assert({ subject: "p:1", predicate: "plan", value: "pro", space: "org", actor: "x" });
        l.forget({ factId: secret.fact.factId, actor: "dpo", reason: "request" });
        l.close();
        const bytes = readFileSync(f, "latin1");
        expect(bytes).not.toContain("SSN-987-65-4321");
        expect(bytes).toContain("pro");
        const again = new Ledger(f);
        expect(again.facts().find((x) => x.factId === secret.fact.factId)?.forgotten?.digestKind).toBe("sha256");
        expect(again.export().map((e) => e.kind)).toEqual(["assert", "assert", "forget"]);
        again.close();
      });
    });
  }

  it("sqlite: a second process appending is seen on reopen, and the write-ahead log holds no forgotten value", () => {
    const f = join(dir(), "shared.sqlite");
    const l = new Ledger(f);
    const a = l.assert({ subject: "s", predicate: "p", value: "visible", space: "org", actor: "x" });
    const other = spawnSync(process.execPath, ["-e", `
      import("${join(import.meta.dirname, "..", "src", "index.ts")}").then(({ Ledger }) => {
        const l = new Ledger(${JSON.stringify(f)});
        l.assert({ subject: "t", predicate: "q", value: "from-another-process", space: "org", actor: "y" });
        l.close();
      });`], { encoding: "utf8", timeout: 30_000 });
    expect(other.status, other.stderr).toBe(0);
    l.close();
    const again = new Ledger(f);
    expect(again.size).toBe(2);
    again.forget({ factId: a.fact.factId, actor: "dpo", reason: "r" });
    again.close();
    for (const suffix of ["", "-wal"]) {
      try {
        expect(readFileSync(f + suffix, "latin1")).not.toContain("visible");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
  });

  it("export writes the auditable JSONL from a SQLite ledger, and a JSONL ledger reads it back identically", () => {
    const d = dir();
    const l = new Ledger(join(d, "ledger.sqlite"));
    l.assert({ subject: "s", predicate: "p", value: { nested: [1, 2] }, space: "org", actor: "x" });
    l.close();
    const r = spawnSync(process.execPath, [join(import.meta.dirname, "..", "src", "cli.ts"), "export", "--ledger", join(d, "ledger.sqlite"), "--out", join(d, "out.jsonl")], { encoding: "utf8", timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    const back = new Ledger(join(d, "out.jsonl"));
    expect(back.export()).toEqual(new Ledger(join(d, "ledger.sqlite")).export());
  });

  it("the stores can be passed directly", () => {
    const d = dir();
    expect(new Ledger(new JsonlStore(join(d, "x.log"))).location).toMatch(/x\.log$/);
    expect(new Ledger(new SqliteStore(join(d, "y.sqlite"))).location).toMatch(/y\.sqlite$/);
  });
});

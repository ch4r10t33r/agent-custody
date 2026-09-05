// The ledger exists so a wrong belief can be found, dated, and undone without losing what the agent believed at the time.
// Every test here is a question a platform owner asks after a memory incident.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger.ts";

/** A clock the tests advance by hand, so transaction time is exact. */
function clock(start = "2026-09-01T00:00:00.000Z") {
  let t = new Date(start);
  return { now: () => t, set: (iso: string) => (t = new Date(iso)) };
}

const file = () => join(mkdtempSync(join(tmpdir(), "state-ledger-")), "ledger.jsonl");

describe("fact ledger", () => {
  it("answers what is believed now, filtered by space, subject and predicate", () => {
    const l = new Ledger(file(), clock());
    l.assert({ subject: "acct:42", predicate: "plan", value: "pro", space: "org", actor: "agent:support" });
    l.assert({ subject: "acct:42", predicate: "owner", value: "dana", space: "org", actor: "agent:support" });
    l.assert({ subject: "acct:42", predicate: "plan", value: "trial", space: "user:me", actor: "user:me" });
    expect(l.asOf({ space: "org" }).map((f) => f.value)).toEqual(["pro", "dana"]);
    expect(l.asOf({ subject: "acct:42", predicate: "plan" }).map((f) => f.space)).toEqual(["org", "user:me"]);
  });

  it("superseding a fact ends its validity where the replacement begins, so the old value is still true for its own interval", () => {
    const c = clock();
    const l = new Ledger(file(), c);
    const a = l.assert({ subject: "acct:42", predicate: "plan", value: "pro", space: "org", actor: "agent:support", validFrom: "2026-08-01T00:00:00.000Z" });
    c.set("2026-09-10T00:00:00.000Z");
    l.assert({ subject: "acct:42", predicate: "plan", value: "enterprise", space: "org", actor: "agent:sales", supersedes: a.fact.factId, validFrom: "2026-09-10T00:00:00.000Z" });
    expect(l.asOf({ validAt: "2026-08-15T00:00:00.000Z" }).map((f) => f.value)).toEqual(["pro"]);
    expect(l.asOf({ validAt: "2026-09-10T00:00:00.000Z" }).map((f) => f.value)).toEqual(["enterprise"]);
    expect(l.asOf({ validAt: "2026-09-10T00:00:00.000Z" })[0]!.actor).toBe("agent:sales");
  });

  it("distinguishes when a fact was true from when the ledger learned it", () => {
    const c = clock("2026-09-05T00:00:00.000Z");
    const l = new Ledger(file(), c);
    // Learned on the 5th that the contract had been signed on the 1st.
    l.assert({ subject: "deal:7", predicate: "status", value: "signed", space: "org", actor: "agent:ops", validFrom: "2026-09-01T00:00:00.000Z" });
    // On the 3rd the deal was signed, but nobody knew yet.
    expect(l.asOf({ validAt: "2026-09-03T00:00:00.000Z", txAt: "2026-09-03T00:00:00.000Z" })).toEqual([]);
    expect(l.asOf({ validAt: "2026-09-03T00:00:00.000Z" }).map((f) => f.value)).toEqual(["signed"]);
  });

  it("retracting a wrong fact removes it from now but not from what was believed before the retraction", () => {
    const c = clock();
    const l = new Ledger(file(), c);
    const bad = l.assert({ subject: "acct:42", predicate: "owner", value: "mallory", space: "org", actor: "agent:intern", source: { receiptId: "r-1" } });
    c.set("2026-09-02T00:00:00.000Z");
    const r = l.retract({ factId: bad.fact.factId, actor: "user:admin", reason: "poisoned by a tool result" });
    expect(l.asOf()).toEqual([]);
    expect(l.asOf({ validAt: "2026-09-01T12:00:00.000Z", txAt: "2026-09-01T12:00:00.000Z" }).map((f) => f.value)).toEqual(["mallory"]);
    expect(l.history(bad.fact.factId).map((e) => e.kind)).toEqual(["assert", "retract"]);
    expect(r.reason).toBe("poisoned by a tool result");
  });

  it("retracting the replacement restores the fact it superseded", () => {
    const c = clock();
    const l = new Ledger(file(), c);
    const good = l.assert({ subject: "acct:42", predicate: "plan", value: "pro", space: "org", actor: "agent:support" });
    c.set("2026-09-02T00:00:00.000Z");
    const bad = l.assert({ subject: "acct:42", predicate: "plan", value: "free", space: "org", actor: "agent:intern", supersedes: good.fact.factId });
    expect(l.asOf().map((f) => f.value)).toEqual(["free"]);
    c.set("2026-09-03T00:00:00.000Z");
    l.retract({ factId: bad.fact.factId, actor: "user:admin", reason: "wrong" });
    expect(l.asOf().map((f) => f.value)).toEqual(["pro"]);
    // and the restored fact can be superseded again, by a better write this time
    c.set("2026-09-04T00:00:00.000Z");
    l.assert({ subject: "acct:42", predicate: "plan", value: "enterprise", space: "org", actor: "agent:sales", supersedes: good.fact.factId });
    expect(l.asOf().map((f) => f.value)).toEqual(["enterprise"]);
  });

  it("refuses to supersede a fact that is unknown, already superseded, or retracted, and refuses a replacement that starts earlier", () => {
    const c = clock();
    const l = new Ledger(file(), c);
    const a = l.assert({ subject: "s", predicate: "p", value: 1, space: "org", actor: "x", validFrom: "2026-09-01T00:00:00.000Z" });
    expect(() => l.assert({ subject: "s", predicate: "p", value: 2, space: "org", actor: "x", supersedes: "nope" })).toThrow(/unknown fact/);
    expect(() => l.assert({ subject: "s", predicate: "p", value: 2, space: "org", actor: "x", supersedes: a.fact.factId, validFrom: "2026-08-01T00:00:00.000Z" })).toThrow(/cannot start before/);
    c.set("2026-09-02T00:00:00.000Z");
    const b = l.assert({ subject: "s", predicate: "p", value: 2, space: "org", actor: "x", supersedes: a.fact.factId });
    expect(() => l.assert({ subject: "s", predicate: "p", value: 3, space: "org", actor: "x", supersedes: a.fact.factId })).toThrow(/already superseded/);
    l.retract({ factId: b.fact.factId, actor: "x", reason: "wrong" });
    expect(() => l.assert({ subject: "s", predicate: "p", value: 3, space: "org", actor: "x", supersedes: b.fact.factId })).toThrow(/is retracted/);
    expect(() => l.retract({ factId: b.fact.factId, actor: "x", reason: "again" })).toThrow(/already retracted/);
  });

  it("persists every event as one JSON line and reopens to the same beliefs", () => {
    const c = clock();
    const f = file();
    const l = new Ledger(f, c);
    const a = l.assert({ subject: "s", predicate: "p", value: 1, space: "org", actor: "x", source: { receiptId: "r-9" } });
    c.set("2026-09-02T00:00:00.000Z");
    l.assert({ subject: "s", predicate: "p", value: 2, space: "org", actor: "y", supersedes: a.fact.factId });
    const lines = readFileSync(f, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).fact.source).toEqual({ receiptId: "r-9" });
    const reopened = new Ledger(f, c);
    expect(reopened.size).toBe(2);
    expect(reopened.asOf()).toEqual(l.asOf());
    expect(reopened.asOf({ validAt: "2026-09-01T12:00:00.000Z" }).map((x) => x.value)).toEqual([1]);
  });
});

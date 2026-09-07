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

const backends = [["jsonl", "ledger.jsonl"], ["sqlite", "ledger.sqlite"]] as const;

describe.each(backends)("fact ledger on %s", (_name, filename) => {
  const file = () => join(mkdtempSync(join(tmpdir(), "state-ledger-")), filename);
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
    if (filename.endsWith(".jsonl")) {
      const lines = readFileSync(f, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!).fact.source).toEqual({ receiptId: "r-9" });
    }
    const reopened = new Ledger(f, c);
    expect(reopened.size).toBe(2);
    expect(reopened.asOf()).toEqual(l.asOf());
    expect(reopened.asOf({ validAt: "2026-09-01T12:00:00.000Z" }).map((x) => x.value)).toEqual([1]);
  });

  it("a claimed fact is quarantined until an attested party confirms it, and the confirmation has its own transaction time", () => {
    const c = clock();
    const l = new Ledger(file(), c);
    const claimed = l.assert({ subject: "acct:42", predicate: "owner", value: "dana", space: "org", actor: "sdk-bot" });
    const attested = l.assert({ subject: "acct:42", predicate: "plan", value: "pro", space: "org", actor: "support-agent", provenance: "attested", source: { receiptId: "r-1" } });
    expect(l.asOf({ include: "attested" }).map((f) => f.factId)).toEqual([attested.fact.factId]);
    expect(l.asOf().map((f) => f.provenance)).toEqual(["claimed", "attested"]);
    c.set("2026-09-02T00:00:00.000Z");
    const ok = l.confirm({ factId: claimed.fact.factId, actor: "support-agent", source: { receiptId: "r-2" } });
    expect(ok.kind).toBe("confirm");
    expect(l.asOf({ include: "attested" }).map((f) => f.factId).sort()).toEqual([claimed.fact.factId, attested.fact.factId].sort());
    // before the confirmation was recorded, the fact was still in quarantine
    expect(l.asOf({ include: "attested", validAt: "2026-09-01T12:00:00.000Z", txAt: "2026-09-01T12:00:00.000Z" }).map((f) => f.factId)).toEqual([attested.fact.factId]);
    expect(l.history(claimed.fact.factId).map((e) => e.kind)).toEqual(["assert", "confirm"]);
    expect(() => l.confirm({ factId: claimed.fact.factId, actor: "x" })).toThrow(/already attested/);
    expect(() => l.confirm({ factId: attested.fact.factId, actor: "x" })).toThrow(/already attested/);
    expect(() => l.confirm({ factId: "nope", actor: "x" })).toThrow(/unknown fact/);
    l.retract({ factId: claimed.fact.factId, actor: "x", reason: "wrong" });
    expect(() => l.confirm({ factId: claimed.fact.factId, actor: "x" })).toThrow(/is retracted/);
    const reopened = new Ledger(l.location, c);
    expect(reopened.size).toBe(4);
  });

  it("forgetting erases the value from the file, keeps its digest, stops believing it, and survives reopening", () => {
    const c = clock();
    const f = file();
    const l = new Ledger(f, c);
    const secret = l.assert({ subject: "person:1", predicate: "ssn", value: "123-45-6789", space: "org", actor: "intake", provenance: "attested", source: { receiptId: "r-1" } });
    l.assert({ subject: "person:1", predicate: "plan", value: "pro", space: "org", actor: "intake" });
    c.set("2026-09-03T00:00:00.000Z");
    const ev = l.forget({ factId: secret.fact.factId, actor: "user:dpo", reason: "deletion request 4471", source: { receiptId: "r-9" } });
    expect(ev.kind).toBe("forget");
    expect(ev.valueDigest).toMatch(/^[0-9a-f]{64}$/);
    const raw = readFileSync(f, "latin1");
    expect(raw).not.toContain("123-45-6789");
    expect(raw).toContain(ev.valueDigest);
    expect(l.asOf({ subject: "person:1" }).map((x) => x.predicate)).toEqual(["plan"]);
    expect(l.history(secret.fact.factId).map((e) => e.kind)).toEqual(["assert", "forget"]);
    expect(l.facts().find((x) => x.factId === secret.fact.factId)).toMatchObject({ value: null, forgotten: { valueDigest: ev.valueDigest, at: "2026-09-03T00:00:00.000Z" } });
    // what was believed before the erasure still answers, without the value
    expect(l.asOf({ subject: "person:1", validAt: "2026-09-02T00:00:00.000Z", txAt: "2026-09-02T00:00:00.000Z" }).map((x) => [x.predicate, x.value])).toEqual([["ssn", null], ["plan", "pro"]]);
    const reopened = new Ledger(f, c);
    expect(reopened.size).toBe(3);
    expect(reopened.asOf({ subject: "person:1" })).toHaveLength(1);
    expect(() => l.forget({ factId: secret.fact.factId, actor: "x", reason: "again" })).toThrow(/already forgotten/);
    expect(() => l.forget({ factId: "nope", actor: "x", reason: "x" })).toThrow(/unknown fact/);
  });

  it("provenance is ranked: include verified leaves out attested, include attested leaves out claimed", () => {
    const l = new Ledger(file(), clock());
    l.assert({ subject: "s", predicate: "a", value: 1, space: "org", actor: "x" });
    l.assert({ subject: "s", predicate: "b", value: 2, space: "org", actor: "x", provenance: "attested" });
    l.assert({ subject: "s", predicate: "c", value: 3, space: "org", actor: "x", provenance: "verified" });
    expect(l.asOf({ include: "verified" }).map((f) => f.predicate)).toEqual(["c"]);
    expect(l.asOf({ include: "attested" }).map((f) => f.predicate)).toEqual(["b", "c"]);
    expect(l.asOf().map((f) => f.predicate)).toEqual(["a", "b", "c"]);
    const v = l.asOf({ include: "verified" })[0]!;
    expect(() => l.confirm({ factId: v.factId, actor: "x" })).toThrow(/already attested/);
  });

  it("a legal hold refuses forget and sweep until released; a sweep forgets what was learned before the cutoff", () => {
    const c = clock("2026-09-01T00:00:00.000Z");
    const l = new Ledger(file(), c);
    const old = l.assert({ subject: "p:1", predicate: "email", value: "a@x", space: "org", actor: "x" });
    const kept = l.assert({ subject: "p:2", predicate: "email", value: "b@x", space: "org", actor: "x" });
    const other = l.assert({ subject: "p:3", predicate: "email", value: "c@x", space: "team", actor: "x" });
    c.set("2026-09-10T00:00:00.000Z");
    const recent = l.assert({ subject: "p:4", predicate: "email", value: "d@x", space: "org", actor: "x" });
    l.hold({ factId: kept.fact.factId, actor: "legal", reason: "litigation 12" });
    expect(l.held(kept.fact.factId)).toBe(true);
    expect(() => l.forget({ factId: kept.fact.factId, actor: "x", reason: "request" })).toThrow(/legal hold/);
    expect(() => l.hold({ factId: kept.fact.factId, actor: "legal", reason: "again" })).toThrow(/already on hold/);
    const r = l.sweep({ before: "2026-09-05T00:00:00.000Z", space: "org", actor: "retention", reason: "90 days" });
    expect(r.forgotten.map((e) => e.factId)).toEqual([old.fact.factId]);
    expect(r.held).toEqual([kept.fact.factId]);
    expect(l.facts().find((f) => f.factId === other.fact.factId)?.forgotten).toBeUndefined();
    expect(l.facts().find((f) => f.factId === recent.fact.factId)?.forgotten).toBeUndefined();
    l.release({ factId: kept.fact.factId, actor: "legal", reason: "matter closed" });
    expect(l.held(kept.fact.factId)).toBe(false);
    expect(() => l.release({ factId: kept.fact.factId, actor: "legal", reason: "twice" })).toThrow(/not on hold/);
    expect(l.forget({ factId: kept.fact.factId, actor: "x", reason: "request" }).kind).toBe("forget");
    expect(l.history(kept.fact.factId).map((e) => e.kind)).toEqual(["assert", "hold", "release", "forget"]);
  });

  it("a forget key turns the kept digest into an HMAC, and keepDigest false keeps nothing", () => {
    const f1 = file();
    const a = new Ledger(f1, { ...clock(), forgetKey: "secret-one" });
    const b = new Ledger(file(), { ...clock(), forgetKey: "secret-two" });
    const plain = new Ledger(file(), clock());
    const write = (l: Ledger) => l.assert({ subject: "p:1", predicate: "email", value: "dana@example.com", space: "org", actor: "x" }).fact.factId;
    const ea = a.forget({ factId: write(a), actor: "dpo", reason: "request" });
    const eb = b.forget({ factId: write(b), actor: "dpo", reason: "request" });
    const ep = plain.forget({ factId: write(plain), actor: "dpo", reason: "request" });
    expect(ea.digestKind).toBe("hmac-sha256");
    expect(eb.digestKind).toBe("hmac-sha256");
    expect(ep.digestKind).toBe("sha256");
    expect(ea.valueDigest).not.toBe(eb.valueDigest);
    expect(ea.valueDigest).not.toBe(ep.valueDigest);
    expect(readFileSync(f1, "utf8")).not.toContain("dana@example.com");
    // the same secret reproduces the digest, which is how the ledger proves what it erased to someone shown the key
    const again = new Ledger(file(), { ...clock(), forgetKey: "secret-one" });
    expect(again.forget({ factId: write(again), actor: "dpo", reason: "request" }).valueDigest).toBe(ea.valueDigest);
    const none = new Ledger(file(), { ...clock(), forgetKey: "secret-one" });
    const en = none.forget({ factId: write(none), actor: "dpo", reason: "request", keepDigest: false });
    expect(en).toMatchObject({ digestKind: "none", valueDigest: null });
    expect(none.facts()[0]?.forgotten).toMatchObject({ digestKind: "none", valueDigest: null });
    expect(none.sweep({ before: new Date(Date.now() + 1000).toISOString(), actor: "r", reason: "r", keepDigest: false }).forgotten).toEqual([]);
  });
});

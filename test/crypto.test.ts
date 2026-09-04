import { describe, expect, it } from "vitest";
import { canonicalize, digestOf, dsseSign, dsseVerify, generateKeyPair } from "../src/crypto.ts";

describe("canonicalize", () => {
  it("is independent of key order and drops undefined, so digests are stable", () => {
    expect(canonicalize({ b: 1, a: { d: undefined, c: [3, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[3,{"y":2,"z":1}]},"b":1}');
    expect(digestOf({ a: 1, b: 2 })).toBe(digestOf({ b: 2, a: 1 }));
  });
});

describe("DSSE", () => {
  const kp = generateKeyPair();
  const other = generateKeyPair();

  it("round-trips a payload under the signing key", () => {
    const env = dsseSign("t/x", { hello: "world" }, kp);
    const r = dsseVerify(env, [other, kp]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload).toEqual({ hello: "world" });
  });

  it("rejects a modified payload, which is the whole point of a receipt", () => {
    const env = dsseSign("t/x", { amount: 500 }, kp);
    env.payload = Buffer.from(JSON.stringify({ amount: 5 })).toString("base64");
    expect(dsseVerify(env, [kp]).ok).toBe(false);
  });

  it("rejects a signature from a key the verifier does not trust", () => {
    const env = dsseSign("t/x", { a: 1 }, other);
    const r = dsseVerify(env, [kp]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no trusted key/);
  });

  it("binds the payloadType, so a delegation cannot be replayed as a receipt", () => {
    const env = dsseSign("delegation", { a: 1 }, kp);
    env.payloadType = "receipt";
    expect(dsseVerify(env, [kp]).ok).toBe(false);
  });
});

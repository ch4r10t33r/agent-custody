// A delegation grant: a principal signs a statement that an agent may use certain tools for a window of time.
import { z } from "zod";
import { dsseSign, dsseVerify, type Envelope, type KeyPair, type PublicKeyRef } from "./crypto.ts";

export const DELEGATION_TYPE = "application/vnd.agent-custody.delegation+json";

export const DelegationSchema = z.object({
  version: z.literal("0.1"),
  principal: z.string().min(1),
  agent: z.string().min(1),
  scopes: z.array(z.string().min(1)).min(1),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type Delegation = z.infer<typeof DelegationSchema>;

export function createDelegation(principalKey: KeyPair, d: Delegation): Envelope {
  return dsseSign(DELEGATION_TYPE, DelegationSchema.parse(d), principalKey);
}

export type DelegationVerifyResult =
  | { ok: true; delegation: Delegation; keyid: string }
  | { ok: false; error: string };

export function verifyDelegation(env: Envelope, trustedPrincipals: PublicKeyRef[]): DelegationVerifyResult {
  if (env.payloadType !== DELEGATION_TYPE) return { ok: false, error: `unexpected payloadType ${env.payloadType}` };
  const r = dsseVerify(env, trustedPrincipals);
  if (!r.ok) return r;
  const parsed = DelegationSchema.safeParse(r.payload);
  if (!parsed.success) return { ok: false, error: `invalid delegation: ${parsed.error.message}` };
  return { ok: true, delegation: parsed.data, keyid: r.keyid };
}

/** True when `at` (ISO) lies inside the grant's validity window. */
export function delegationValidAt(d: Delegation, at: string): boolean {
  const t = Date.parse(at);
  return t >= Date.parse(d.issuedAt) && t <= Date.parse(d.expiresAt);
}

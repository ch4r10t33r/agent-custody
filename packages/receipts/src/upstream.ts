// Attested execution. An upstream that holds a key can sign what it returned, bound to the receipt the gateway is
// issuing, so the receipt's execution is no longer only what the gateway observed but what the upstream itself vouches
// for. The upstream puts a DSSE envelope on its result's _meta; the gateway embeds it; a verifier who trusts the
// upstream's key checks it. Provider-native formats, such as Stripe's webhook signatures, are adapters on top of this.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { digestOf, dsseSign, dsseVerify, type Envelope, type KeyPair, type PublicKeyRef } from "./crypto.ts";

export const UPSTREAM_SIG_META_KEY = "agent-custody/upstream-signature";
export const UPSTREAM_TYPE = "application/vnd.agent-custody.upstream+json";

export interface UpstreamAttestation {
  receiptId: string;
  tool: string;
  /** digest of { content, isError } of the result: what the agent received, without the _meta the signature lives in */
  contentDigest: string;
}

export function contentDigest(result: { content: unknown; isError?: boolean | undefined }): string {
  return digestOf({ content: result.content, isError: !!result.isError });
}

/** For upstreams: signs the result for this receipt and returns it with the envelope attached. */
export function signResult<R extends CallToolResult>(result: R, key: KeyPair, receiptId: string, tool: string): R {
  const payload: UpstreamAttestation = { receiptId, tool, contentDigest: contentDigest(result) };
  return { ...result, _meta: { ...result._meta, [UPSTREAM_SIG_META_KEY]: dsseSign(UPSTREAM_TYPE, payload, key) } };
}

/** For the gateway: the envelope an upstream attached, if any. */
export function upstreamSignatureOf(result: CallToolResult): Envelope | null {
  const env = result._meta?.[UPSTREAM_SIG_META_KEY] as Envelope | undefined;
  return env && typeof env.payload === "string" && Array.isArray(env.signatures) ? env : null;
}

export type UpstreamCheck = { ok: true; keyid: string } | { ok: false; error: string };

/** For verifiers: the envelope must verify against a trusted upstream key and bind to this receipt, tool, and content. */
export function checkUpstream(envelope: Envelope, keys: PublicKeyRef[], expected: UpstreamAttestation): UpstreamCheck {
  const v = dsseVerify(envelope, keys);
  if (!v.ok) return { ok: false, error: v.error };
  if (envelope.payloadType !== UPSTREAM_TYPE) return { ok: false, error: `payload type ${envelope.payloadType}` };
  const p = v.payload as Partial<UpstreamAttestation>;
  if (p.receiptId !== expected.receiptId) return { ok: false, error: "signed for a different receipt" };
  if (p.tool !== expected.tool) return { ok: false, error: `signed for tool ${String(p.tool)}` };
  if (p.contentDigest !== expected.contentDigest) return { ok: false, error: "signed content differs from the result in the receipt" };
  return { ok: true, keyid: v.keyid };
}

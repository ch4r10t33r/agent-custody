// Vercel AI SDK adapter: wraps every tool's execute() in a ToolSet. Decides, runs, records.
// Typed structurally so this file does not import the `ai` package.
import { PolicyDeniedError, receiptIdOf, type SdkIssuer } from "./index.ts";

// Parameters are `any` on purpose: each tool's execute() has its own input type, and a narrower structural signature
// here would not be assignable under strictFunctionTypes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExecuteFn = (input: any, options: any) => unknown;

/** Returns a new ToolSet. Tools without execute (client-side or provider-executed) pass through unchanged. */
export function wrapTools<T extends Record<string, { execute?: ExecuteFn }>>(issuer: SdkIssuer, tools: T): T {
  const out: Record<string, unknown> = {};
  for (const [name, t] of Object.entries(tools)) {
    const original = t.execute;
    if (!original) {
      out[name] = t;
      continue;
    }
    const execute: ExecuteFn = async (input: unknown, options: { toolCallId?: string } | undefined) => {
      const args = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : { input };
      const ev = { tool: name, args, session: { id: null, toolUseId: options?.toolCallId ?? null } };
      const policy = issuer.decide(ev);
      if (policy && policy.decision === "deny") {
        const reason = [...policy.reasons, ...policy.errors].join("; ") || "no permit policy matched";
        const bundle = await issuer.record(ev, { status: "denied", reason }, policy);
        throw new PolicyDeniedError(name, reason, receiptIdOf(bundle));
      }
      try {
        const result = await original(input, options);
        await issuer.record(ev, { status: "executed", result }, policy);
        return result;
      } catch (e) {
        await issuer.record(ev, { status: "error", error: e instanceof Error ? e.message : String(e) }, policy);
        throw e;
      }
    };
    out[name] = { ...t, execute };
  }
  return out as T;
}

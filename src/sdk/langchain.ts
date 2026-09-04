// LangChain / LangGraph (JS) adapter: a callback handler that issues a receipt for every tool run it observes.
// Observe-only. LangChain callbacks cannot block a tool, so this handler evaluates no policy. For enforcement,
// construct the tool with issuer.wrap(): tool(issuer.wrap("name", fn), { name, schema }). Do not combine both on
// one tool, or it will be recorded twice.
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { SdkIssuer, ToolEvent } from "./index.ts";

function parseArgs(input: string): Record<string, unknown> {
  try {
    const v = JSON.parse(input) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { input: v };
  } catch {
    return { input };
  }
}

/** LangChain hands the handler either the raw return value or a ToolMessage. Record the content either way. */
function unwrapOutput(output: unknown): unknown {
  if (output && typeof output === "object" && "content" in output && "tool_call_id" in output) {
    const content = (output as { content: unknown }).content;
    if (typeof content === "string") {
      try {
        return JSON.parse(content) as unknown;
      } catch {
        return content;
      }
    }
    return content;
  }
  return output;
}

export class ReceiptCallbackHandler extends BaseCallbackHandler {
  name = "agent-receipts";
  private readonly issuer: SdkIssuer;
  private readonly pending = new Map<string, ToolEvent>();

  constructor(issuer: SdkIssuer) {
    super();
    this.issuer = issuer;
  }

  override handleToolStart(
    tool: { name?: string },
    input: string,
    runId: string,
    _parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
    toolCallId?: string,
  ): void {
    const name = runName ?? tool.name ?? "unknown";
    this.pending.set(runId, { tool: name, args: parseArgs(input), session: { id: null, toolUseId: toolCallId ?? null } });
  }

  override handleToolEnd(output: unknown, runId: string): void {
    const ev = this.pending.get(runId);
    if (!ev) return;
    this.pending.delete(runId);
    this.issuer.record(ev, { status: "executed", result: unwrapOutput(output) }, null);
  }

  override handleToolError(err: Error, runId: string): void {
    const ev = this.pending.get(runId);
    if (!ev) return;
    this.pending.delete(runId);
    this.issuer.record(ev, { status: "error", error: err.message }, null);
  }
}

/** Convenience: `tool.invoke(args, receiptCallbacks(issuer))`, or spread into any RunnableConfig. */
export function receiptCallbacks(issuer: SdkIssuer): { callbacks: ReceiptCallbackHandler[] } {
  return { callbacks: [new ReceiptCallbackHandler(issuer)] };
}

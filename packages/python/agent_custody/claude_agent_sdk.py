"""Claude Agent SDK (Python) hooks. Same contract as the TypeScript adapter and the Claude Code command hook.

PreToolUse: evaluate policy; on deny, record a denial receipt and block. On allow or no policy return no decision,
so the host's own permission flow still applies. This never auto-approves. PostToolUse / PostToolUseFailure record.

    from claude_agent_sdk import HookMatcher
    hooks = {event: [HookMatcher(hooks=[claude_hook(client)])] for event in ("PreToolUse", "PostToolUse", "PostToolUseFailure")}
"""
from __future__ import annotations

from typing import Any, Callable, Dict, Optional

from . import Client, receipt_id_of


def _event(input_data: Dict[str, Any]) -> Dict[str, Any]:
    raw = input_data.get("tool_input")
    args = raw if isinstance(raw, dict) else {"input": raw}
    return {"tool": input_data["tool_name"], "args": args, "session": {"id": input_data.get("session_id"), "toolUseId": input_data.get("tool_use_id")}}


def handle_hook_event(client: Client, input_data: Dict[str, Any]) -> Dict[str, Any]:
    ev = _event(input_data)
    name = input_data.get("hook_event_name")
    if name == "PreToolUse":
        policy = client.decide(ev["tool"], ev["args"], session=ev["session"])
        if policy and policy["decision"] == "deny":
            reason = "; ".join(policy["reasons"] + policy["errors"]) or "no permit policy matched"
            bundle = client.record(ev["tool"], ev["args"], {"status": "denied", "reason": reason}, policy, session=ev["session"])
            return {"continue": True, "hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": f"agent-custody: {reason} (receipt {receipt_id_of(bundle)})"}}
        return {}
    if name == "PostToolUse":
        client.record(ev["tool"], ev["args"], {"status": "executed", "result": input_data.get("tool_response")}, client.decide(ev["tool"], ev["args"]), session=ev["session"])
        return {}
    if name == "PostToolUseFailure":
        client.record(ev["tool"], ev["args"], {"status": "failed", "result": input_data.get("error", input_data.get("tool_response"))}, client.decide(ev["tool"], ev["args"]), session=ev["session"])
        return {}
    return {}


def claude_hook(client: Client) -> Callable[[Dict[str, Any], Optional[str], Any], Any]:
    """A hook callable in the shape the Claude Agent SDK expects: (input_data, tool_use_id, context) -> dict."""

    async def hook(input_data: Dict[str, Any], tool_use_id: Optional[str], context: Any) -> Dict[str, Any]:
        return handle_hook_event(client, input_data)

    return hook

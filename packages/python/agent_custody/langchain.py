"""LangChain / LangGraph adapter: a callback handler that records a receipt for every tool run it sees.

Observe-only. Callbacks cannot block a tool, so this evaluates no policy. For enforcement wrap the function before
turning it into a tool: `tool(client.wrap("name", fn))`. Do not combine both on one tool, or it is recorded twice.
"""
from __future__ import annotations

import json
from typing import Any, Dict, Optional
from uuid import UUID

from langchain_core.callbacks import BaseCallbackHandler

from . import Client


def _parse_args(input_str: str, inputs: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if isinstance(inputs, dict):
        return inputs
    try:
        v = json.loads(input_str)
        return v if isinstance(v, dict) else {"input": v}
    except (TypeError, ValueError):
        return {"input": input_str}


def _unwrap(output: Any) -> Any:
    content = getattr(output, "content", None) if hasattr(output, "tool_call_id") else None
    if content is None:
        return output
    if isinstance(content, str):
        try:
            return json.loads(content)
        except ValueError:
            return content
    return content


class ReceiptCallbackHandler(BaseCallbackHandler):
    name = "agent-custody"

    def __init__(self, client: Client):
        super().__init__()
        self.client = client
        self._pending: Dict[UUID, Dict[str, Any]] = {}

    def on_tool_start(self, serialized: Dict[str, Any], input_str: str, *, run_id: UUID, parent_run_id: Optional[UUID] = None, tags=None, metadata=None, inputs: Optional[Dict[str, Any]] = None, **kwargs: Any) -> None:
        name = kwargs.get("name") or (serialized or {}).get("name") or "unknown"
        self._pending[run_id] = {"tool": name, "args": _parse_args(input_str, inputs), "session": {"id": None, "toolUseId": kwargs.get("tool_call_id")}}

    def on_tool_end(self, output: Any, *, run_id: UUID, **kwargs: Any) -> None:
        ev = self._pending.pop(run_id, None)
        if ev is None:
            return
        self.client.record(ev["tool"], ev["args"], {"status": "executed", "result": _unwrap(output)}, None, session=ev["session"])

    def on_tool_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        ev = self._pending.pop(run_id, None)
        if ev is None:
            return
        self.client.record(ev["tool"], ev["args"], {"status": "error", "error": str(error)}, None, session=ev["session"])

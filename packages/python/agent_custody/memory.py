"""The memory tools from Python, over MCP, against the shared memory server (`agent-custody-memory serve --http`).

Writes made this way are claimed: they did not come through the receipts gateway, so the ledger quarantines them
until a gateway confirms them. That is the honest position of an SDK-only agent, and the point of a shared ledger:
the fleet sees what a gateway-attested agent wrote, and what this agent wrote waits for confirmation.

    async with MemoryClient("http://127.0.0.1:8790/mcp", token="...") as memory:
        fact = await memory.write("acct:42", "plan", "pro", space="team:support", actor="py-agent")
        facts = await memory.read(subject="acct:42", include_claimed=True)
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.shared._httpx_utils import create_mcp_http_client

__all__ = ["MemoryClient", "MemoryError"]


class MemoryError(RuntimeError):
    """The memory server refused the call. Nothing was written."""


class MemoryClient:
    def __init__(self, url: str, token: Optional[str] = None):
        self.url = url
        self.token = token
        self._cm = None
        self._session: Optional[ClientSession] = None

    async def __aenter__(self) -> "MemoryClient":
        headers = {"authorization": f"Bearer {self.token}"} if self.token else None
        self._cm = streamable_http_client(self.url, http_client=create_mcp_http_client(headers=headers))
        read, write = await self._cm.__aenter__()
        self._session = ClientSession(read, write)
        await self._session.__aenter__()
        await self._session.initialize()
        return self

    async def __aexit__(self, *exc: Any) -> None:
        if self._session is not None:
            await self._session.__aexit__(*exc)
        if self._cm is not None:
            await self._cm.__aexit__(*exc)

    async def _call(self, tool: str, args: Dict[str, Any]) -> Any:
        assert self._session is not None, "use `async with MemoryClient(...) as memory:`"
        result = await self._session.call_tool(tool, {k: v for k, v in args.items() if v is not None})
        text = next((c.text for c in result.content if getattr(c, "type", None) == "text"), "")
        if getattr(result, "is_error", None) or getattr(result, "isError", None):
            raise MemoryError(text)
        return json.loads(text) if text else None

    async def write(self, subject: str, predicate: str, value: Any, *, space: str, actor: Optional[str] = None, supersedes: Optional[str] = None, valid_from: Optional[str] = None) -> Dict[str, Any]:
        """Records a belief. Returns {fact, eventId, txTime, supersedes}; the fact's provenance is claimed."""
        return await self._call("memory.write", {"subject": subject, "predicate": predicate, "value": value, "space": space, "actor": actor, "supersedes": supersedes, "validFrom": valid_from})

    async def read(self, *, subject: Optional[str] = None, predicate: Optional[str] = None, space: Optional[str] = None, valid_at: Optional[str] = None, tx_at: Optional[str] = None, include_claimed: bool = False, require_verified: bool = False) -> List[Dict[str, Any]]:
        """The facts believed at a moment. Quarantined facts, including this client's own unconfirmed writes, are left out unless include_claimed."""
        out = await self._call("memory.read", {"subject": subject, "predicate": predicate, "space": space, "validAt": valid_at, "txAt": tx_at, "includeClaimed": include_claimed or None, "requireVerified": require_verified or None})
        return out["facts"]

    async def retract(self, fact_id: str, reason: str, *, actor: Optional[str] = None) -> Dict[str, Any]:
        return await self._call("memory.retract", {"factId": fact_id, "reason": reason, "actor": actor})

    async def history(self, fact_id: str) -> List[Dict[str, Any]]:
        return (await self._call("memory.history", {"factId": fact_id}))["events"]

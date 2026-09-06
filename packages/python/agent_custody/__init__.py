"""Receipts for tool calls, from Python.

The signing key, the policy, and the log live in the agent-custody sidecar, `agent-custody serve --config sdk.json`,
a local process. This client talks to it over HTTP with nothing but the standard library. Everything recorded is
claimed, exactly as with the in-process TypeScript SDK: the sidecar trusts what this process reports.
"""
from __future__ import annotations

import base64
import json
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, Optional

__all__ = ["Client", "PolicyDeniedError", "SidecarError", "receipt_id_of"]

DEFAULT_URL = "http://127.0.0.1:8788/"


class SidecarError(RuntimeError):
    """The sidecar refused or could not complete a request. No receipt was written."""


class PolicyDeniedError(PermissionError):
    def __init__(self, tool: str, reason: str, receipt_id: str):
        super().__init__(f"Denied by policy: {reason} (receipt {receipt_id})")
        self.tool = tool
        self.reason = reason
        self.receipt_id = receipt_id


def receipt_id_of(bundle: Dict[str, Any]) -> str:
    payload = json.loads(base64.b64decode(bundle["envelope"]["payload"]))
    return payload["predicate"]["receiptId"]


def _event(tool: str, args: Optional[Dict[str, Any]], model: Optional[str], session: Optional[Dict[str, Optional[str]]]) -> Dict[str, Any]:
    ev: Dict[str, Any] = {"tool": tool, "args": args or {}}
    if model is not None:
        ev["model"] = model
    if session is not None:
        ev["session"] = session
    return ev


class Client:
    def __init__(self, url: str = DEFAULT_URL, timeout: float = 10.0):
        self.url = url if url.endswith("/") else url + "/"
        self.timeout = timeout

    def _post(self, path: str, body: Any) -> Any:
        req = urllib.request.Request(self.url + path, data=json.dumps(body).encode(), headers={"content-type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                return json.loads(res.read())
        except urllib.error.HTTPError as e:
            try:
                detail = json.loads(e.read()).get("error", "")
            except Exception:
                detail = ""
            raise SidecarError(f"sidecar {path}: {e.code} {detail}".strip()) from None
        except urllib.error.URLError as e:
            raise SidecarError(f"sidecar unreachable at {self.url}: {e.reason}") from None

    def health(self) -> Dict[str, Any]:
        with urllib.request.urlopen(self.url + "health", timeout=self.timeout) as res:
            return json.loads(res.read())

    def decide(self, tool: str, args: Optional[Dict[str, Any]] = None, *, model: Optional[str] = None, session: Optional[Dict[str, Optional[str]]] = None) -> Optional[Dict[str, Any]]:
        """The configured policy's decision for this call, or None when the sidecar has no policy."""
        return self._post("decide", _event(tool, args, model, session))

    def record(self, tool: str, args: Optional[Dict[str, Any]], outcome: Dict[str, Any], policy: Optional[Dict[str, Any]] = None, *, model: Optional[str] = None, session: Optional[Dict[str, Optional[str]]] = None) -> Dict[str, Any]:
        """Issues one receipt. `outcome` is {"status": "executed"|"failed", "result": ...}, {"status": "denied", "reason": ...}, or {"status": "error", "error": ...}."""
        return self._post("record", {"event": _event(tool, args, model, session), "outcome": outcome, "policy": policy})

    def wrap(self, tool: str, fn: Callable[[Dict[str, Any]], Any], *, model: Optional[str] = None) -> Callable[[Dict[str, Any]], Any]:
        """decide, run, record. Raises PolicyDeniedError on deny, after recording the denial."""

        def wrapped(args: Dict[str, Any]) -> Any:
            policy = self.decide(tool, args, model=model)
            if policy and policy["decision"] == "deny":
                reason = "; ".join(policy["reasons"] + policy["errors"]) or "no permit policy matched"
                bundle = self.record(tool, args, {"status": "denied", "reason": reason}, policy, model=model)
                raise PolicyDeniedError(tool, reason, receipt_id_of(bundle))
            try:
                result = fn(args)
            except Exception as e:
                self.record(tool, args, {"status": "error", "error": str(e)}, policy, model=model)
                raise
            self.record(tool, args, {"status": "executed", "result": result}, policy, model=model)
            return result

        wrapped.__name__ = getattr(fn, "__name__", tool)
        return wrapped

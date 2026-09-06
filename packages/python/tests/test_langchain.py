# Against the real langchain-core: a StructuredTool invoked with the handler in the config. No model, no network.
from langchain_core.tools import tool

from agent_custody.langchain import ReceiptCallbackHandler
from conftest import receipt_count, verify


@tool
def refund(amount: int) -> dict:
    """Refund an amount."""
    return {"refund_id": "re_lc", "amount": amount}


@tool
def flaky(id: str) -> dict:
    """Always fails."""
    raise RuntimeError("upstream down")


def test_every_tool_run_gets_a_receipt(client, sidecar):
    handler = ReceiptCallbackHandler(client)
    before = receipt_count(sidecar)
    assert refund.invoke({"amount": 7}, config={"callbacks": [handler]}) == {"refund_id": "re_lc", "amount": 7}
    try:
        flaky.invoke({"id": "c1"}, config={"callbacks": [handler]})
    except RuntimeError:
        pass
    assert receipt_count(sidecar) == before + 2
    newest = sorted(sidecar["receipts"].glob("*.json"), key=lambda p: p.stat().st_mtime)[-2:]
    statuses = {verify(sidecar, p.stem)["statement"]["predicate"]["execution"]["status"] for p in newest}
    assert statuses == {"executed", "error"}

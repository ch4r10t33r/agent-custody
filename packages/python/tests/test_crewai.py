# Against the real crewai package: a BaseTool built with @tool, run the way a crew runs it, through the sidecar.
from crewai.tools import tool

from agent_custody.crewai import wrap_tools
from conftest import receipt_count, verify


@tool("stripe.refund")
def refund(amount: int) -> dict:
    """Refund an amount, in minor units."""
    return {"refund_id": "re_crew", "amount": amount}


@tool("customer.lookup")
def lookup(customer_id: str) -> str:
    """Look a customer up."""
    return '{"id": "' + customer_id + '", "verified": true}'


def test_wrapped_tools_enforce_and_record(client, sidecar):
    wrapped = wrap_tools(client, [refund, lookup])
    r, l = wrapped
    assert r.name == "stripe.refund" and r.description == refund.description and r.args_schema is refund.args_schema
    before = receipt_count(sidecar)
    ok = r.run(amount=9)
    assert ok == {"refund_id": "re_crew", "amount": 9}
    denied = r.run(amount=900000)
    assert str(denied).startswith("Denied by policy:")
    found = l.run(customer_id="cust_7")
    assert '"verified": true' in found
    assert receipt_count(sidecar) == before + 3
    # the newest receipts verify with the sidecar's key, and the denial ran nothing
    newest = sorted(sidecar["receipts"].glob("*.json"), key=lambda p: p.stat().st_mtime)[-3:]
    reports = [verify(sidecar, p.stem) for p in newest]
    assert all(r["ok"] for r in reports)
    assert sorted(r["statement"]["predicate"]["execution"]["status"] for r in reports) == ["denied", "executed", "executed"]

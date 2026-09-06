# Against the real openai-agents package: a FunctionTool built by @function_tool, invoked the way the runner invokes it.
import asyncio

from agents import RunConfig, function_tool
from agents.tool_context import ToolContext

from agent_custody.openai_agents import wrap_tools
from conftest import receipt_count, verify


@function_tool(name_override="stripe.refund")
def refund(amount: int) -> dict:
    """Refund an amount."""
    return {"refund_id": "re_oa", "amount": amount}


def test_wrapped_tool_enforces_and_records(client, sidecar):
    wrapped = wrap_tools(client, [refund])[0]
    ctx = lambda input_json: ToolContext(context=None, tool_name="stripe.refund", tool_call_id="call-1", tool_arguments=input_json, run_config=RunConfig())
    before = receipt_count(sidecar)
    ok = asyncio.run(wrapped.on_invoke_tool(ctx('{"amount": 9}'), '{"amount": 9}'))
    denied = asyncio.run(wrapped.on_invoke_tool(ctx('{"amount": 900000}'), '{"amount": 900000}'))
    assert "re_oa" in str(ok)
    assert str(denied).startswith("Denied by policy:")
    assert receipt_count(sidecar) == before + 2
    assert wrapped.name == refund.name and wrapped.params_json_schema == refund.params_json_schema

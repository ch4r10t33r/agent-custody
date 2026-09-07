# agent-custody (Python)

Signed, verifiable receipts for AI agent tool calls, from Python. The key, the Cedar policy, and the Merkle log live in the agent-custody sidecar, a local process from the npm package; this client talks to it over HTTP with the standard library only.

```bash
npm install -g @agent-custody/receipts && agent-custody keygen --dir keys --name app
agent-custody serve --config sdk.json          # loopback, port 8788
pip install agent-custody
```

```python
from agent_custody import Client, PolicyDeniedError

client = Client()                                # http://127.0.0.1:8788/
refund = client.wrap("stripe.refund", lambda args: stripe.refund(**args))
refund({"amount": 5000})                         # decide, run, record; raises PolicyDeniedError on deny
```

Adapters, each tested against the real package: `agent_custody.langchain.ReceiptCallbackHandler` (record-only), `agent_custody.openai_agents.wrap_tools` (enforce and record), `agent_custody.claude_agent_sdk.claude_hook` (PreToolUse deny, PostToolUse record). Receipts are verified by the TypeScript verifier; the tests do exactly that.

**The memory tools.** `agent_custody.memory.MemoryClient` (extra `memory`) talks to the shared memory server from `@agent-custody/state` over MCP: write, read, retract, history. Writes from here are `claimed`, quarantined until a gateway confirms them, and reads leave quarantined facts out unless asked; that is the honest position of an agent that did not go through the gateway.

```python
async with MemoryClient("http://127.0.0.1:8790/mcp", token=os.environ["MEMORY_TOKEN"]) as memory:
    await memory.write("acct:42", "plan", "pro", space="team:support", actor="py-agent")
    await memory.read(subject="acct:42", include_claimed=True)
```

Everything recorded is `claimed`: the sidecar trusts what this process reports, the same as the in-process TypeScript SDK. For enforcement the agent cannot skip, put the gateway in front of the tools instead; it is an MCP server and needs nothing from this package.

```bash
uv run --extra test pytest        # from packages/python; starts a sidecar with node from ../receipts
```

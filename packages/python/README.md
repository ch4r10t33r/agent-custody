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

Everything recorded is `claimed`: the sidecar trusts what this process reports, the same as the in-process TypeScript SDK. For enforcement the agent cannot skip, put the gateway in front of the tools instead; it is an MCP server and needs nothing from this package.

```bash
uv run --extra test pytest        # from packages/python; starts a sidecar with node from ../receipts
```

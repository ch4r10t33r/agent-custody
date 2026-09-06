# The smallest possible client, standard library only. SIDECAR_URL points at `agent-custody serve`.
import json, os, urllib.request

url = os.environ.get("SIDECAR_URL", "http://127.0.0.1:8788/")
post = lambda path, body: json.loads(urllib.request.urlopen(urllib.request.Request(url + path, data=json.dumps(body).encode(), headers={"content-type": "application/json"})).read())

event = {"tool": "stripe.refund", "args": {"amount": 500}, "session": {"id": "py-run", "toolUseId": "call-1"}}
policy = post("decide", event)
if policy and policy["decision"] == "deny":
    post("record", {"event": event, "outcome": {"status": "denied", "reason": "policy"}, "policy": policy})
    raise SystemExit("denied")
result = {"refund_id": "re_py", "amount": 500}                         # the tool ran here
bundle = post("record", {"event": event, "outcome": {"status": "executed", "result": result}, "policy": policy})
print("python: receipt at tree size", bundle["inclusion"]["treeSize"])
print("OK")

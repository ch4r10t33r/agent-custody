// The smallest possible client. SIDECAR_URL points at `agent-custody serve`.
use serde_json::{json, Value};

fn post(url: &str, path: &str, body: &Value) -> Value {
    ureq::post(&format!("{url}{path}"))
        .send_json(body)
        .unwrap_or_else(|e| panic!("{path}: {e}"))
        .into_json()
        .expect("json body")
}

fn main() {
    let url = std::env::var("SIDECAR_URL").unwrap_or_else(|_| "http://127.0.0.1:8788/".into());
    let event = json!({ "tool": "stripe.refund", "args": { "amount": 500 }, "session": { "id": "rust-run", "toolUseId": "call-1" } });
    let policy = post(&url, "decide", &event);
    if policy["decision"] == "deny" {
        post(&url, "record", &json!({ "event": event, "outcome": { "status": "denied", "reason": "policy" }, "policy": policy }));
        eprintln!("denied");
        std::process::exit(1);
    }
    let result = json!({ "refund_id": "re_rust", "amount": 500 }); // the tool ran here
    let bundle = post(&url, "record", &json!({ "event": event, "outcome": { "status": "executed", "result": result }, "policy": policy }));
    println!("rust: receipt at tree size {}", bundle["inclusion"]["treeSize"]);
    println!("OK");
}

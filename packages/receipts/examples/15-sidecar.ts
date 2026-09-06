// Aspect: agents in other languages. Source: src/sidecar.ts
// Run:    node examples/15-sidecar.ts
// The sidecar is the SDK issuer behind a local HTTP API. This example is the client side of that API, written the way a
// Python, Go, Java, or Rust agent would write it: decide, run the tool, record. packages/python and examples/languages/
// hold the real clients.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSdkConfig } from "../src/config.ts";
import { loadPublicKey } from "../src/crypto.ts";
import { createSdkIssuer } from "../src/sdk/index.ts";
import { serveSidecar } from "../src/sidecar.ts";
import { verifyBundle } from "../src/verify.ts";
import { buildSdkFixture } from "../scripts/fixture.ts";

const step = (n: number, s: string) => console.log(`\n${n}. ${s}`);
const fx = buildSdkFixture(mkdtempSync(join(tmpdir(), "sidecar-example-")));

step(1, "start the sidecar on a free port; in production this is `agent-custody serve --config sdk.json`");
const side = await serveSidecar(createSdkIssuer(loadSdkConfig(fx.configFile)), { port: 0 });
const post = async (path: string, body: unknown) => (await fetch(new URL(path, side.url), { method: "POST", body: JSON.stringify(body) })).json();
console.log("   ", side.url, JSON.stringify(await (await fetch(new URL("health", side.url))).json()));

step(2, "the client asks for a decision before running the tool; the policy sees only the args the client sends");
const event = { tool: "stripe.refund", args: { amount: 500 }, session: { id: "run-7", toolUseId: "call-1" } };
const policy = (await post("decide", event)) as { decision: string };
console.log("    decision:", policy.decision);

step(3, "the client runs the tool itself, then records the outcome with the decision it was given");
const result = { refund_id: "re_1", amount: 500 };
const bundle = (await post("record", { event, outcome: { status: "executed", result }, policy })) as Parameters<typeof verifyBundle>[0];
console.log("    receipt tree size:", bundle.inclusion.treeSize);

step(4, "a denied decision means the client must not run the tool; it records the denial instead");
const big = { tool: "stripe.refund", args: { amount: 500000 } };
const deny = (await post("decide", big)) as { decision: string; reasons: string[] };
const denial = (await post("record", { event: big, outcome: { status: "denied", reason: "over limit" }, policy: deny })) as Parameters<typeof verifyBundle>[0];
console.log("    decision:", deny.decision, "| denial receipt tree size:", denial.inclusion.treeSize);

step(5, "both receipts verify like any SDK receipt: issuer kind sdk, every field claimed");
const v1 = verifyBundle(bundle, { issuerKeys: [loadPublicKey(fx.appPub)], principalKeys: [], logFile: fx.logFile });
const v2 = verifyBundle(denial, { issuerKeys: [loadPublicKey(fx.appPub)], principalKeys: [], logFile: fx.logFile });
console.log("    verified:", v1.ok, v2.ok, "| kinds:", v1.statement?.predicate.issuer.kind, v2.statement?.predicate.execution.status);

await side.close();
if (!v1.ok || !v2.ok || policy.decision !== "allow" || deny.decision !== "deny") throw new Error("unexpected");
console.log("\nOK");

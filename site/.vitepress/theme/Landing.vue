<script setup lang="ts">
// The product's front door, outside the docs theme: one story, one receipt, one action, three doors. Issue #52.
// The receipt is the gateway-denied conformance vector, decoded at build time: a £50,000 refund the policy refused
// before it reached the payment provider, with the customer fact the gateway fetched itself. Every byte verifies
// against the published keys; the identities are the test fixture's. This repository's own receipts are on /custody.
import vectors from "../../../packages/receipts/vectors/receipts.json";
import { useData } from "vitepress";
import Flow from "./Flow.vue";
import Demo from "./Demo.vue";

const { isDark } = useData();

const sample = "gateway-denied";
const bundle = (vectors.cases as any[]).find((c) => c.name === sample).bundle;
const decode = (b64: string) => JSON.parse(typeof Buffer !== "undefined" ? Buffer.from(b64, "base64").toString("utf8") : atob(b64));
const receipt = decode(bundle.envelope.payload).predicate;
const head = decode(bundle.treeHead.payload);
const short = (h: string) => h.slice(0, 12) + "…";
const pounds = (pence: number) => "£" + (pence / 100).toLocaleString("en-GB", { minimumFractionDigits: 2 });
const customer = receipt.facts.customer;
const year = new Date().getUTCFullYear();
</script>

<template>
  <div class="landing">
    <header class="bar">
      <a class="brand" href="/"><svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" /><circle cx="32" cy="32" r="19" fill="none" stroke="#fff" stroke-width="4.5" /><path d="M22 33.5l7 6.5 13-15" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" /></svg>agent-custody</a>
      <nav aria-label="Site"><a href="/" aria-current="page">Product</a><a href="/guide/getting-started">Docs</a><a href="/pricing">Pricing</a><a href="/verify">Verify</a><a href="https://app.agent-custody.dev/">Sign in</a><button class="theme" type="button" :aria-label="isDark ? 'Switch to light mode' : 'Switch to dark mode'" @click="isDark = !isDark">{{ isDark ? "Light" : "Dark" }}</button></nav>
    </header>

    <main>
      <section class="story">
        <p class="kicker">Proof of what your AI agents did</p>
        <h1>An agent asked for a £50,000 refund. The policy allowed £1,000. The call never reached the payment provider. This is the receipt.</h1>
        <p class="lede">agent-custody puts a gateway between an agent and its tools. Every call is checked against a grant a person signed and a policy, then forwarded or denied, and a signed receipt is issued either way. A stranger can check the receipt with a public key. Nobody in the chain can rewrite the record.</p>
      </section>

      <figure class="receipt">
        <figcaption>A gateway receipt, from the published conformance vectors</figcaption>
        <dl>
          <dt>decision</dt><dd><span class="decision" :data-d="receipt.policy.decision">{{ receipt.execution.status }}</span> <span class="why">{{ receipt.execution.reason }}; nothing was sent upstream</span></dd>
          <dt>tool</dt><dd>{{ receipt.tool.name }} <span class="why">{{ receipt.tool.provenance }}</span></dd>
          <dt>asked for</dt><dd>refund {{ pounds(receipt.request.args.amount) }} to {{ receipt.request.args.customer_id }} <span class="why">{{ receipt.request.provenance }}: the agent's own words</span></dd>
          <dt>the gateway checked</dt><dd>customer {{ customer.value.id }}, {{ customer.value.email }}, verified {{ customer.value.verified }} <span class="why">{{ customer.provenance }}: fetched by the gateway, not the agent</span></dd>
          <dt>policy</dt><dd>refunds up to £1,000 for a customer the gateway verified · sha256 {{ short(receipt.policy.policyDigest) }}</dd>
          <dt>agent</dt><dd>{{ receipt.agent.id }} <span class="why">{{ receipt.agent.provenance }}</span></dd>
          <dt>authorized by</dt><dd>{{ receipt.principal.id }} <span class="why">{{ receipt.principal.provenance }}: a grant they signed, embedded</span></dd>
          <dt>when</dt><dd>{{ receipt.timestamp.replace("T", " ").slice(0, 19) }} UTC</dd>
          <dt>log</dt><dd>leaf {{ bundle.inclusion.leafIndex + 1 }} of {{ head.treeSize }} · root {{ short(head.rootHash) }}</dd>
          <dt>receipt</dt><dd>{{ receipt.receiptId }}</dd>
        </dl>
        <p class="open"><a class="go" :href="`/verify?sample=${sample}`">Open in the verifier</a><span>Runs in your browser with the gateway's and the principal's public keys. Nothing is uploaded.</span></p>
      </figure>

      <p class="limit">A receipt proves what was signed, observed, and logged, and labels everything else as the agent's own claim. The <a href="/receipts/#what-a-receipt-proves-and-what-it-does-not">proof table</a> says which is which, for whoever has to sign off.</p>

      <section class="doors" aria-label="Where to go">
        <a class="door" href="/guide/getting-started">
          <b>Try it</b>
          <p>Pick a stack: Claude Code, the Claude Agent SDK, the OpenAI Agents SDK, LangChain, Vercel AI, Python. Ten minutes to a receipt that verifies in the browser.</p>
          <span class="note">The SDK path records the agent's own word.</span>
        </a>
        <a class="door" href="/receipts/usage">
          <b>Make it evidence</b>
          <p>The gateway, a signed grant, and a log run by someone else. The path for a call that moves money or touches production.</p>
          <span class="note">Hosted log: free to 10,000 appends a month.</span>
        </a>
        <a class="door" href="/security">
          <b>For security review</b>
          <p>The questionnaire with every no left as a no, the threat model, the compliance mapping, and what you are trusting in each setup.</p>
          <span class="note">Dated, and honest about the witness.</span>
        </a>
      </section>

      <figure class="promo">
        <video controls playsinline preload="none" poster="/promo-poster.jpg" width="1920" height="1080" aria-label="A 63-second film: Maya, head of support, signs a grant for her support agent. A customer's £500 refund goes through the gateway to Stripe. A line slipped into a ticket makes the agent try a £5,000 refund, and the gateway denies it before it reaches Stripe. The signed receipt is logged in a Merkle log, an auditor verifies it with public keys, and an edited receipt fails verification.">
          <source src="/promo.mp4" type="video/mp4" />
        </video>
        <figcaption>A refund agent, a prompt injection, and the receipt that settles it. The receipts are real ones from <code>bun run demo</code>, against a stand-in Stripe; 63 seconds, with sound, and nothing loads until you press play.</figcaption>
      </figure>

      <Flow />
      <Demo />

      <section class="compare">
        <h2>Not a trace. Not an application log.</h2>
        <div class="wrap"><table>
          <thead><tr><th></th><th>Application log</th><th>Trace<br /><small>OpenTelemetry, LangSmith</small></th><th>Gateway receipt</th></tr></thead>
          <tbody>
            <tr><th>Written by</th><td>the agent's process</td><td>the agent's process</td><td>a gateway the agent talks to, signing with its own key</td></tr>
            <tr><th>Says the call was allowed or denied before the tool ran</th><td>no</td><td>no</td><td>yes, and the denial is a receipt too</td></tr>
            <tr><th>Who authorized it</th><td>not recorded</td><td>not recorded</td><td>the grant a person signed, embedded and verified</td></tr>
            <tr><th>Can a third party show the record was not rewritten</th><td>no</td><td>no</td><td>yes: a Merkle log with heads signed by a key the operator does not hold</td></tr>
            <tr><th>Who can check it</th><td>whoever has the log access</td><td>whoever has the tracing account</td><td>anyone with the public keys, offline</td></tr>
          </tbody>
        </table></div>
        <p>Traces stay useful. A receipt can be exported to OpenTelemetry or Splunk as one span or event per call, with the receipt id as the trace id, so the evidence and the observability sit side by side.</p>
      </section>

      <section class="proof">
        <h2>The operator runs on it</h2>
        <p>This repository is developed under custody: every tool call the coding agent makes is a receipt, hash-logged to our tenant on the hosted log. The <a href="/custody">custody page</a> shows the hook, the policy, the keys, and two of those receipts to verify. The hosted log is <a href="/early-access">taking tenants</a>; the pricing page says what is and is not promised on each plan.</p>
      </section>
    </main>

    <footer>
      <p>Apache-2.0 · <a href="https://github.com/ch4r10t33r/agent-custody">GitHub</a> · <a href="https://www.npmjs.com/org/agent-custody">npm</a> · <a href="https://pypi.org/project/agent-custody/">PyPI</a> · <a href="/reference/">Reference</a> · <a href="/security">Security</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/contact">Contact</a></p>
      <p>Charioteer Consulting Ltd, {{ year }}</p>
    </footer>
  </div>
</template>

<style scoped>
.landing { --amber: var(--vp-c-brand-1); --mono: var(--vp-font-family-mono); min-height: 100vh; background: var(--vp-c-bg); color: var(--vp-c-text-1); font-family: var(--vp-font-family-base); line-height: 1.55; }
.bar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; max-width: 46rem; margin: 0 auto; padding: 1.1rem 1.25rem; }
.brand { display: inline-flex; align-items: center; gap: .55rem; font-weight: 700; letter-spacing: .01em; color: var(--vp-c-text-1); text-decoration: none; }
.brand svg { width: 22px; height: 22px; display: block; } .brand rect { fill: var(--amber); }
.bar nav { display: flex; gap: 1.1rem; font-size: .92rem; flex-wrap: wrap; justify-content: flex-end; }
.bar nav a { color: var(--vp-c-text-2); text-decoration: none; } .bar nav a:hover, .bar nav a[aria-current] { color: var(--vp-c-text-1); }
.bar .theme { font: inherit; font-size: .8rem; color: var(--vp-c-text-2); background: transparent; border: 1px solid var(--vp-c-divider); border-radius: 5px; padding: .15rem .55rem; cursor: pointer; } .bar .theme:hover { color: var(--vp-c-text-1); }
main { max-width: 46rem; margin: 0 auto; padding: 1.5rem 1.25rem 3rem; }
.kicker { font-family: var(--mono); font-size: .78rem; letter-spacing: .1em; text-transform: uppercase; color: var(--vp-c-text-2); margin: 0 0 .8rem; }
h1 { font-size: clamp(1.7rem, 4.6vw, 2.5rem); line-height: 1.15; letter-spacing: -.02em; margin: 0 0 1rem; text-wrap: balance; }
.lede { font-size: 1.08rem; color: var(--vp-c-text-2); margin: 0 0 2rem; max-width: 42em; }
.receipt { margin: 0 0 1.2rem; padding: 1.1rem 1.3rem 1.2rem; border: 1px solid var(--vp-c-divider); border-radius: 8px; background: var(--vp-c-bg-soft); font-family: var(--mono); font-size: .86rem; }
.receipt figcaption { font-family: var(--vp-font-family-base); font-size: .8rem; letter-spacing: .06em; text-transform: uppercase; color: var(--vp-c-text-2); margin: 0 0 .9rem; }
.receipt dl { display: grid; grid-template-columns: max-content 1fr; gap: .38rem 1.2rem; margin: 0; }
.receipt dt { color: var(--vp-c-text-2); } .receipt dd { margin: 0; overflow-wrap: anywhere; }
.decision { text-transform: uppercase; font-weight: 700; letter-spacing: .06em; padding: 0 .4rem; border: 1.5px solid currentColor; border-radius: 3px; }
.decision[data-d="deny"] { color: var(--vp-c-danger-1); } .decision[data-d="allow"] { color: var(--vp-c-success-1); }
.why { color: var(--vp-c-text-2); }
.open { display: flex; gap: .9rem; align-items: center; flex-wrap: wrap; margin: 1.1rem 0 0; font-family: var(--vp-font-family-base); font-size: .9rem; }
.go { display: inline-block; padding: .6rem 1.2rem; border-radius: 6px; background: var(--amber); color: #fff; font-weight: 600; text-decoration: none; }
.go:hover { filter: brightness(1.08); }
.open span { color: var(--vp-c-text-2); }
.limit { font-size: .95rem; color: var(--vp-c-text-2); margin: 0 0 2.5rem; }
.limit a, .compare a, .proof a, footer a { color: var(--vp-c-text-1); text-decoration: underline; text-underline-offset: .18em; }
.doors { display: grid; grid-template-columns: repeat(3, 1fr); gap: .9rem; margin: 0 0 3rem; }
.door { display: flex; flex-direction: column; gap: .5rem; padding: 1rem 1.1rem 1.1rem; border: 1px solid var(--vp-c-divider); border-radius: 8px; color: var(--vp-c-text-1); text-decoration: none; background: var(--vp-c-bg); }
.door:hover { border-color: var(--vp-c-text-2); }
.door b { font-size: 1.05rem; } .door p { margin: 0; font-size: .9rem; color: var(--vp-c-text-2); flex: 1; }
.door .note { font-family: var(--mono); font-size: .72rem; color: var(--vp-c-text-2); padding-top: .5rem; border-top: 1px solid var(--vp-c-divider); }
.promo { margin: 0 0 3rem; }
.promo video { display: block; width: 100%; height: auto; border: 1px solid var(--vp-c-divider); border-radius: 8px; background: #1b1b1f; }
.promo figcaption { margin-top: .8rem; font-size: .9rem; color: var(--vp-c-text-2); }
h2 { font-size: 1.25rem; letter-spacing: -.01em; margin: 0 0 .8rem; }
.compare { margin: 0 0 3rem; } .compare p { color: var(--vp-c-text-2); font-size: .95rem; margin: 1rem 0 0; }
.wrap { overflow-x: auto; }
.compare table { border-collapse: collapse; width: 100%; font-size: .88rem; min-width: 34rem; }
.compare th, .compare td { text-align: left; vertical-align: top; padding: .55rem .7rem .55rem 0; border-bottom: 1px solid var(--vp-c-divider); }
.compare thead th { font-size: .74rem; letter-spacing: .06em; text-transform: uppercase; color: var(--vp-c-text-2); } .compare thead small { text-transform: none; letter-spacing: 0; font-weight: 400; }
.compare tbody th { font-weight: 600; width: 30%; color: var(--vp-c-text-1); }
.compare td { color: var(--vp-c-text-2); } .compare td:last-child { color: var(--vp-c-text-1); }
.proof p { color: var(--vp-c-text-2); font-size: .95rem; margin: 0; }
footer { max-width: 46rem; margin: 0 auto; padding: 1.5rem 1.25rem 3rem; border-top: 1px solid var(--vp-c-divider); font-size: .85rem; color: var(--vp-c-text-2); }
footer p { margin: 0 0 .3rem; }
@media (max-width: 40rem) { .doors { grid-template-columns: 1fr; } .receipt dl { grid-template-columns: 1fr; gap: .1rem; } .receipt dt { margin-top: .5rem; } }
</style>

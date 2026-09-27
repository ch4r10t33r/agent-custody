<script setup lang="ts">
// The home page above the fold: the claim, one action, and a real receipt from this repository's own custody, the
// denied `git push --force`. Decoded at build time from the same file the custody page links; the control opens it
// in the browser verifier with the agent's key and the log's key.
import bundle from "../../public/custody/47eb52af-9cd0-4428-bbdc-b44c04a1f266.json";

const id = "47eb52af-9cd0-4428-bbdc-b44c04a1f266";
const decode = (b64: string) => JSON.parse(typeof Buffer !== "undefined" ? Buffer.from(b64, "base64").toString("utf8") : atob(b64));
const receipt = decode(bundle.envelope.payload).predicate;
const head = decode(bundle.treeHead.payload);
const short = (h: string) => h.slice(0, 12) + "…";

const steps = [
  { title: "Authorize", text: "A human signs a grant. A gateway between the agent and its tools checks it, and a policy, on every call that goes through it.", link: "/receipts/usage" },
  { title: "Execute", text: "Only permitted calls reach the tool. For consequential tools the authorization is logged before the call goes out.", link: "/receipts/usage" },
  { title: "Record", text: "One signed receipt per call, allowed or denied, as a leaf in a Merkle log.", link: "/receipts/" },
  { title: "Verify", text: "Public keys and nothing else, in the shell or in the browser.", link: "/verify" },
  { title: "Trace", text: "Every belief cites the receipt that produced it. From one action or one wrong fact, find everything that depended on it.", link: "/state/#blast-radius" },
  { title: "Remediate", text: "Retract a belief and what it displaced returns. Forget a value from the ledger and the adapted stores, and the receipt records what each store answered.", link: "/state/#certified-forget" },
];
</script>

<template>
  <section class="home">
    <h1 class="claim">Proof of what your AI agents did</h1>
    <p class="lede">A signed receipt for every tool call an agent makes through the gateway: who authorized it, what the agent saw, what it did, what depended on it. Checkable by anyone with the public keys.</p>
    <p class="act"><a class="go" href="/guide/getting-started">Get started</a><a class="also" href="/receipts/#what-a-receipt-proves-and-what-it-does-not">What a receipt proves</a></p>

    <figure class="receipt">
      <figcaption><span class="mark" aria-hidden="true"><svg viewBox="0 0 64 64"><rect width="64" height="64" rx="14"/><circle cx="32" cy="32" r="19" fill="none" stroke="#fff" stroke-width="4.5"/><path d="M22 33.5l7 6.5 13-15" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>A receipt from this repository's own custody</figcaption>
      <dl>
        <dt>decision</dt><dd><span class="decision" :data-d="receipt.policy.decision">{{ receipt.execution.status }}</span> <span class="why">{{ receipt.policy.decision === "deny" ? "by policy, before it ran" : "" }}</span></dd>
        <dt>tool</dt><dd>{{ receipt.tool.name }}</dd>
        <dt>command</dt><dd>{{ receipt.request.args.command }}</dd>
        <dt>agent</dt><dd>{{ receipt.agent.id }}</dd>
        <dt>principal</dt><dd>{{ receipt.principal.id }}</dd>
        <dt>when</dt><dd>{{ receipt.timestamp.replace("T", " ").slice(0, 19) }} UTC</dd>
        <dt>policy</dt><dd>sha256 {{ short(receipt.policy.policyDigest) }}</dd>
        <dt>log</dt><dd>{{ head.log }} · leaf {{ bundle.inclusion.leafIndex }} of {{ head.treeSize }} · root {{ short(head.rootHash) }}</dd>
        <dt>receipt</dt><dd>{{ id }}</dd>
      </dl>
      <p class="open"><a :href="`/verify?receipt=${id}`">Open in the verifier</a><span>Runs in your browser with the agent's key and the log's key. Nothing is uploaded.</span></p>
    </figure>

    <ol class="steps">
      <li v-for="(s, i) in steps" :key="s.title">
        <span class="n">{{ i + 1 }}</span>
        <div><a :href="s.link"><b>{{ s.title }}</b></a><p>{{ s.text }}</p></div>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.home { --amber: var(--vp-c-brand-1); --mono: var(--vp-font-family-mono); margin: 1rem 0 2.5rem; }
.claim { font-size: clamp(2rem, 5.5vw, 2.9rem); line-height: 1.12; letter-spacing: -.02em; margin: 0 0 1rem; text-wrap: balance; border: 0; padding: 0; }
.lede { font-size: 1.12rem; line-height: 1.6; color: var(--vp-c-text-2); margin: 0 0 1.5rem; max-width: 40em; }
.act { display: flex; gap: 1.2rem; align-items: center; flex-wrap: wrap; margin: 0 0 2.5rem; }
.go { display: inline-block; padding: .65rem 1.3rem; border-radius: 6px; background: var(--amber); color: #fff !important; font-weight: 600; text-decoration: none !important; }
.go:hover { filter: brightness(1.08); }
.also { color: var(--vp-c-text-1) !important; text-decoration: underline; text-underline-offset: .2em; }
.receipt { margin: 0 0 3rem; padding: 1.1rem 1.3rem 1.2rem; border: 1px solid var(--vp-c-divider); border-radius: 8px; background: var(--vp-c-bg-soft); font-family: var(--mono); font-size: .86rem; }
.receipt figcaption { display: flex; align-items: center; gap: .55rem; font-family: var(--vp-font-family-base); font-size: .82rem; letter-spacing: .06em; text-transform: uppercase; color: var(--vp-c-text-2); margin: 0 0 .9rem; }
.mark svg { width: 18px; height: 18px; display: block; } .mark rect { fill: var(--amber); }
.receipt dl { display: grid; grid-template-columns: max-content 1fr; gap: .38rem 1.2rem; margin: 0; }
.receipt dt { color: var(--vp-c-text-2); } .receipt dd { margin: 0; overflow-wrap: anywhere; }
.decision { text-transform: uppercase; font-weight: 700; letter-spacing: .06em; padding: 0 .4rem; border: 1.5px solid currentColor; border-radius: 3px; }
.decision[data-d="deny"] { color: var(--vp-c-danger-1); } .decision[data-d="allow"] { color: var(--vp-c-success-1); }
.why { color: var(--vp-c-text-2); }
.open { display: flex; gap: .9rem; align-items: baseline; flex-wrap: wrap; margin: 1.1rem 0 0; font-family: var(--vp-font-family-base); font-size: .9rem; }
.open a { display: inline-block; padding: .45rem .9rem; border: 1px solid var(--vp-c-text-1); border-radius: 6px; color: var(--vp-c-text-1) !important; font-weight: 600; text-decoration: none !important; }
.open span { color: var(--vp-c-text-2); }
.steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 1.1rem; }
.steps li { display: grid; grid-template-columns: 2.2rem 1fr; gap: .6rem; align-items: start; }
.steps .n { font-family: var(--mono); font-size: .8rem; color: var(--vp-c-text-2); padding-top: .3rem; border-top: 1px solid var(--vp-c-divider); }
.steps b { font-size: 1.05rem; } .steps a { color: var(--vp-c-text-1) !important; text-decoration: none !important; } .steps a:hover b { text-decoration: underline; }
.steps p { margin: .15rem 0 0; color: var(--vp-c-text-2); line-height: 1.55; }
@media (max-width: 40rem) { .receipt dl { grid-template-columns: 1fr; gap: .1rem; } .receipt dt { margin-top: .5rem; } }
</style>

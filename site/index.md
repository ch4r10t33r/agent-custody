---
layout: home
hero:
  name: agent-custody
  text: Proof of what your AI agents did
  tagline: Every action an agent takes through its tools becomes signed evidence that says who authorized it, what the agent saw, what it did, and what depended on it. Anyone with the public keys can verify it, without trusting the agent, the operator, or the log.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: What each piece is for
      link: /guide/pieces
    - theme: alt
      text: Verify a receipt
      link: /verify
    - theme: alt
      text: Receipt spec
      link: /receipt/v0.2
    - theme: alt
      text: Hosted log, early access
      link: /early-access
features:
  - title: 1. Authorize
    details: A human signs a grant that names the agent and what it may do. An MCP gateway between the agent and its tools checks that grant and a Cedar policy on every call, on facts the gateway fetched itself. The agent cannot skip it.
    link: /receipts/usage
  - title: 2. Execute
    details: Only permitted calls reach the tool. The tool's own answer can be signed by the tool, or attested by Stripe's webhook signature or GitHub's delivery signature, so the outcome is vouched for by something other than the agent.
    link: /receipts/verification#attested-execution
  - title: 3. Record
    details: One signed, in-toto receipt per call, allowed or denied, naming the tool, the arguments, the outcome, the policy that decided, the grant, and the facts the agent had been shown. Each is a leaf in a Merkle transparency log.
    link: /receipts/
  - title: 4. Verify
    details: Anyone with the public keys checks a receipt offline, in the shell or in the browser. A log run by someone else signs the tree heads, and consistency proofs show history was never rewritten.
    link: /verify
  - title: 5. Trace
    details: Every belief the agent holds cites the receipt that produced it, and every receipt records the beliefs the agent saw. From one action or one wrong fact, walk to everything that caused it and everything that depended on it.
    link: /state/#blast-radius
  - title: 6. Remediate
    details: Retract a wrong belief and what it displaced is believed again. Forget a value and the receipt is the certificate that it is gone from the ledger and every store. A legal hold refuses both until released. One signed pack carries all of it to counsel.
    link: /state/#certified-forget
---

## What it does, in one screen

Put the gateway between an agent and its tools. From then on, every tool call answers these questions, and the answers are signed by the gateway, not written by the agent:

| Question | Where the answer is |
| --- | --- |
| Who acted | the agent named in the receipt, `attested` because a human-signed grant names it |
| Who authorized it | the principal who signed the grant, and the grant itself |
| What was allowed | the grant's scopes and the Cedar policy that decided this call |
| What the agent saw | the facts the gateway fetched for the decision, and the beliefs the agent had been shown |
| What it did | the tool, the arguments, and the outcome, allowed or denied |
| Can I check it | yes, offline, with the public keys, at [/verify](/verify) or in the shell |
| Did anything depend on it | the beliefs written from this call and every later call that consumed them |
| What needs reversing | the blast radius, and the retraction or forget that undoes it, receipted |

One command answers all eight for a receipt id, `agent-custody-memory explain`, and packs the answers with every receipt they rest on as a single signed file for whoever has to be convinced. [How it reads](/state/#explain-one-action).

The name is the point: a chain of custody is an evidence record that holds up when the party who made it is the one under question. The agent is not trusted. The layer around it is, and every field of every record says how far that trust extends: `attested` by a signature, `observed` by the gateway, or `claimed` by the agent.

## Why this exists

An agent acts on the world through tools, and it acts on beliefs it picked up along the way. Both leave the same kind of evidence today: the agent's own log, written by the thing you are trying to check, unsigned, editable, and gone when the process is. When a refund goes out that should not have, or a fleet of agents starts repeating a wrong customer fact, nobody can say what happened, who allowed it, where the belief came from, or how to undo it without wiping everything.

Observability records what happened and asks you to trust the record. agent-custody produces evidence: a record an independent party can verify, that names who authorized the action, and that has not been altered since. Receipts cover what an agent did. State covers what it believes and why. Each record says how far it can be trusted, and every one can be checked by someone who has no access to the agent, the operator, or the tools.

### Receipts: what an agent did

`@agent-custody/receipts` produces one signed record per tool call, allowed or denied. The record names the tool and its arguments, the outcome, the policy that decided, and the delegation a human signed, with every field labelled `attested`, `observed`, or `claimed`. Each record is a leaf in a Merkle log, so it cannot be dropped or replaced later, and a log run by someone else can sign the tree heads so the operator cannot rewrite history either.

Two ways to produce them. The **SDK** runs inside the agent's process and records everything it can see; it is honest that this is self-reported. The **gateway** sits between the agent and its tools as an MCP server, fetches the facts a policy needs itself, and stops a denied call before it reaches the tool. A verifier needs public keys and nothing else. [Read more](/receipts/)

### State: what an agent believes

`@agent-custody/state` is a ledger of facts, not a vector store. Every belief carries who wrote it, when it was true, when the ledger learned it, and the receipt that produced it. Beliefs are superseded rather than overwritten and retracted rather than deleted, so "what did the agent believe on Tuesday" is a query, and undoing a wrong belief restores what it displaced.

Run as the gateway's upstream, every write and read is policy-checked and receipted, and the fact's source and actor come from the gateway rather than from the agent's own claims. Three provenance levels follow from that: a write that did not come through the gateway is claimed and quarantined until an attested party confirms it; a write through the gateway is attested; a write whose value the gateway checked against what it fetched itself is verified. Policy sees the fact a write is about to displace, so a self-reported note can be replaced while an attested org fact cannot.

When a belief is wrong, blast radius walks forward through the receipts to every action taken on it and every belief derived from it. When a value must go, forget erases it from the ledger and from every store and the receipt is the certificate; retention runs as receipted sweeps; a legal hold refuses both until it is released. The ledger sits under Mem0 and Zep through write-through adapters, so recall stays where it is. [Read more](/state/)

### How they fit

Receipts are the unit and state is the ledger built from them. A tool call produces a receipt; the belief the agent takes from it cites that receipt; a later action taken on that belief has its own receipt. When something goes wrong, the chain runs both ways: from a bad action back to the belief and the call that produced it, and from a bad belief forward to everything that relied on it.

### What a security owner gets

- **Proof of what an agent did**, per call, allowed or denied, signed and in a log, checkable by an auditor with a public key and nothing else.
- **Enforcement the agent cannot skip**, with a human-signed grant and a policy that decides on facts the gateway fetched itself.
- **Proof of where a belief came from**, and which beliefs the fleet has not yet been allowed to trust.
- **Undo with a blast radius**, so a bad belief is not only reverted but traced to the refunds, emails, and beliefs that depended on it.
- **Certified forget**, a receipt that says the value is gone from the ledger and from every store, checked against each store's search rather than assumed, and a legal hold that stops it when it must not be.
- **Your database**, not ours: the ledger is a JSONL file, SQLite, or a table in the Postgres you already run, and every query is an index lookup. Warehouses get the export.
- **One artefact for counsel**, a signed pack with a fact's history, its receipts, its blast radius, and its forget certificate, verifiable by anyone with two public keys.
- **Retention that runs**, as receipted sweeps, with a record of every sweep and of what a hold kept.
- **A log the operator cannot rewrite**, when the log is run by someone else, and a proof that history was never rewritten between any two receipts.

## Install

::: code-group

```bash [npm]
npm install @agent-custody/receipts @agent-custody/state
```

```bash [Python]
npm install -g @agent-custody/receipts      # the sidecar and the CLI
pip install agent-custody
```

:::

Source, packages, and issues: [github.com/ch4r10t33r/agent-custody](https://github.com/ch4r10t33r/agent-custody) · [@agent-custody/receipts](https://www.npmjs.com/package/@agent-custody/receipts) and [@agent-custody/state](https://www.npmjs.com/package/@agent-custody/state) on npm · [agent-custody](https://pypi.org/project/agent-custody/) on PyPI. Apache-2.0.

<!--@include: ../README.md#pieces-->

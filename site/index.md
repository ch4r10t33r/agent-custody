---
layout: home
hero:
  name: agent-custody
  text: Proof of what your AI agents did
  tagline: Every action an agent takes through the gateway becomes a signed record that says who authorized it, what the agent saw, what it did, and what depended on it. Anyone with the public keys can check it without access to the agent. What each check proves, and what it does not, is a table, not a slogan.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: What each piece is for
      link: /guide/pieces
    - theme: alt
      text: What a receipt proves, and what it does not
      link: /receipts/#what-a-receipt-proves-and-what-it-does-not
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
    details: A human signs a grant that names the agent and what it may do. An MCP gateway between the agent and its tools checks that grant and a Cedar policy on every call, on facts the gateway fetched itself. That holds for every call that goes through the gateway; what does not go through it is listed on the deployment page.
    link: /receipts/usage
  - title: 2. Execute
    details: Only permitted calls reach the tool. The tool's own answer can be signed by the tool, or attested by Stripe's webhook signature or GitHub's delivery signature, so the outcome is vouched for by something other than the agent.
    link: /receipts/verification#attested-execution
  - title: 3. Record
    details: One signed, in-toto receipt per call, allowed or denied, naming the tool, the arguments, the outcome, the policy that decided, the grant, and the facts the agent had been shown. Each is a leaf in a Merkle transparency log.
    link: /receipts/
  - title: 4. Verify
    details: Anyone with the public keys checks a receipt offline, in the shell or in the browser. The default log is a local file signed with the operator's own key, tamper-evident to anyone holding a copy. Only a log run by someone else, which signs the tree heads itself, holds against the operator.
    link: /verify
  - title: 5. Trace
    details: Every belief the agent holds cites the receipt that produced it, and every receipt records the beliefs the agent saw. From one action or one wrong fact, walk to everything that caused it and everything that depended on it.
    link: /state/#blast-radius
  - title: 6. Remediate
    details: Retract a wrong belief and what it displaced is believed again. Forget a value and the receipt certifies what was done, erased from the ledger and from the stores that have adapters, with each store's own answer recorded, including "still indexed". A legal hold refuses both until released. One signed pack carries all of it to counsel.
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

### What you are trusting, by setup

Each setup moves trust one step further from the operator. None of them is free of trust; every receipt says which step it came from.

| setup | what the record is worth | who could still fake or rewrite it |
| --- | --- | --- |
| SDK or sidecar in the agent's process | signed and logged, but self-reported: every field is `claimed` | the agent's own process |
| gateway, with the default local log | the decision and the outcome were observed outside the agent; tamper-evident to anyone holding a copy of the log | the operator, who holds the gateway key and the log file |
| gateway, with a log run by someone else | the tree heads are signed by a key the operator does not hold; history cannot be rewritten without the log noticing | the log's operator, if they collude with yours |

The full list of claims, who can check each, and against whom, is the [proof table](/receipts/#what-a-receipt-proves-and-what-it-does-not). Read it before repeating any sentence on this page to an auditor.

The name is the point: a chain of custody is an evidence record that holds up when the party who made it is the one under question. The agent is not trusted. The layer around it is, and every field of every record says how far that trust extends: `attested` by a signature, `observed` by the gateway, or `claimed` by the agent.

## Why this exists

An agent acts on the world through tools, and it acts on beliefs it picked up along the way. Both leave the same kind of evidence today: the agent's own log, written by the thing you are trying to check, unsigned, editable, and gone when the process is. When a refund goes out that should not have, or a fleet of agents starts repeating a wrong customer fact, nobody can say what happened, who allowed it, where the belief came from, or how to undo it without wiping everything.

Observability records what happened and asks you to trust the record. agent-custody produces a signed record that names who authorized the action and has not been altered since it was logged, and that anyone with the public keys can check without access to the agent or the tools. How far that holds against the operator depends on where the log runs, and the table above says so. Receipts cover what an agent did. State covers what it believes and why. Each record says how far it can be trusted.

### Receipts: what an agent did

`@agent-custody/receipts` produces one signed record per tool call, allowed or denied. The record names the tool and its arguments, the outcome, the policy that decided, and the delegation a human signed, with every field labelled `attested`, `observed`, or `claimed`. Each record is a leaf in a Merkle log, so dropping or replacing one is detectable by anyone holding a copy; with the default local log the operator holds both the key and the file, and it is a log run by someone else, signing the tree heads with its own key, that makes the history hold against the operator too.

Two ways to produce them. The **SDK** runs inside the agent's process and records everything it can see; it is honest that this is self-reported. The **gateway** sits between the agent and its tools as an MCP server, fetches the facts a policy needs itself, and stops a denied call before it reaches the tool. A verifier needs public keys and nothing else. [Read more](/receipts/)

### State: what an agent believes

`@agent-custody/state` is a ledger of facts, not a vector store. Every belief carries who wrote it, when it was true, when the ledger learned it, and the receipt that produced it. Beliefs are superseded rather than overwritten and retracted rather than deleted, so "what did the agent believe on Tuesday" is a query, and undoing a wrong belief restores what it displaced.

Run as the gateway's upstream, every write and read is policy-checked and receipted, and the fact's source and actor come from the gateway rather than from the agent's own claims. Three provenance levels follow from that: a write that did not come through the gateway is claimed and quarantined until an attested party confirms it; a write through the gateway is attested; a write whose value the gateway checked against what it fetched itself is verified. Policy sees the fact a write is about to displace, so a self-reported note can be replaced while an attested org fact cannot.

When a belief is wrong, blast radius walks forward through the receipts to every action taken on it and every belief derived from it. When a value must go, forget erases it from the ledger and from the stores with adapters, and the receipt records what each store answered; it does not reach caches, a model's context, backups, or stores without an adapter. Retention runs as receipted sweeps; a legal hold refuses both until it is released. The ledger sits under Mem0 and Zep through write-through adapters, so recall stays where it is. [Read more](/state/)

### How they fit

Receipts are the unit and state is the ledger built from them. A tool call produces a receipt; the belief the agent takes from it cites that receipt; a later action taken on that belief has its own receipt. When something goes wrong, the chain runs both ways: from a bad action back to the belief and the call that produced it, and from a bad belief forward to everything that relied on it.

### What a security owner gets

- **A signed record of what an agent did**, per call, allowed or denied, in a log, checkable by an auditor with a public key and nothing else. What that record proves, and against whom, is the [proof table](/receipts/#what-a-receipt-proves-and-what-it-does-not).
- **Enforcement for every call through the gateway**, with a human-signed grant and a policy that decides on facts the gateway fetched itself. Calls that bypass the gateway, an API key in the agent's own environment, another MCP server in the host config, an SDK-only wrap, are outside it, and the [deployment page](/guide/deployment#what-the-gateway-does-not-cover) says so.
- **Proof of where a belief came from**, and which beliefs the fleet has not yet been allowed to trust.
- **Undo with a blast radius**, so a bad belief is not only reverted but traced to the refunds, emails, and beliefs that depended on it.
- **Certified forget**, meaning the receipt certifies what was done: the value erased from the ledger and from every store with an adapter, each store's search asked whether it is really gone, and the honest answer recorded, `verified`, `stillIndexed`, or `unverified`. Caches, model context, replicas, backups, and warehouses are out of its reach. A legal hold stops it when it must not run.
- **Your database**, not ours: the ledger is a JSONL file, SQLite, or a table in the Postgres you already run, and every query is an index lookup. Warehouses get the export.
- **One artefact for counsel**, a signed pack with a fact's history, its receipts, its blast radius, and its forget certificate, verifiable by anyone with two public keys.
- **Retention that runs**, as receipted sweeps, with a record of every sweep and of what a hold kept.
- **A log the operator cannot rewrite**, only when the log is run by someone else; the reference log server is in the package, and a hosted one is [not shipping yet](/early-access). With the default local log the operator can rewrite history, and anyone holding a copy can prove that they did.

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

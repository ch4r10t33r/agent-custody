---
layout: home
hero:
  name: agent-custody
  text: Chain of custody for AI agents
  tagline: What an agent did and what it believes, signed, independently verifiable, and revertible. The agent is not trusted; the layer around it is, and every record says how far that trust extends.
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
  - title: Receipts for tool calls
    details: A signed, in-toto statement for every call an agent makes, appended to a Merkle transparency log. Verified offline by anyone with the public keys.
    link: /receipts/
  - title: Enforcement the agent cannot skip
    details: An MCP gateway between the agent and its tools, with a delegation grant signed by a human and a Cedar policy that decides on facts the gateway fetched itself.
    link: /receipts/usage
  - title: A log the operator cannot rewrite
    details: Append to a log run by someone else, whose key signs the tree heads, and prove with consistency proofs that history was never rewritten.
    link: /receipts/verification
  - title: Beliefs with provenance, quarantine, and undo
    details: A bitemporal fact ledger where every belief cites the receipt that produced it. Self-reported writes stay quarantined until confirmed; a value the gateway checked against its source is verified. Retract restores what a wrong belief displaced.
    link: /state/
  - title: Blast radius
    details: Every receipt records what the agent had been shown. From one wrong belief, walk forward to every action taken on it and every belief derived from it, and see what is still believed.
    link: /state/#blast-radius
  - title: Certified forget, retention, legal hold
    details: Forget erases a value from the ledger and every store, and the signed receipt is the certificate. Retention runs as receipted sweeps. A legal hold refuses both until released.
    link: /state/#certified-forget
  - title: Under the stores you already run
    details: Write-through adapters for Mem0 and Zep keep recall where it is and put custody underneath. Any language reaches the gateway; Python, Go, Java, and Rust clients are included.
    link: /state/#write-through-to-the-stores-you-already-use
---

## Why this exists

An agent acts on the world through tools, and it acts on beliefs it picked up along the way. Both leave the same kind of evidence today: the agent's own log, written by the thing you are trying to check, unsigned, editable, and gone when the process is. When a refund goes out that should not have, or a fleet of agents starts repeating a wrong customer fact, nobody can say what happened, who allowed it, where the belief came from, or how to undo it without wiping everything.

agent-custody is the chain of custody for both. Receipts cover what an agent did. State covers what it believes. Each record says how far it can be trusted, and every one can be checked by someone who has no access to the agent, the operator, or the tools.

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
- **Certified forget**, a receipt that says the value is gone from the ledger and from every store, and a legal hold that stops it when it must not be.
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

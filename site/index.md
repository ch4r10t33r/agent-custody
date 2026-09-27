---
title: agent-custody
layout: doc
sidebar: false
aside: false
outline: false
prev: false
next: false
---

<Home />

## What you are trusting

| setup | the record is | who could still rewrite it |
| --- | --- | --- |
| SDK in the agent's process | self-reported, every field `claimed` | the agent's own process |
| gateway, local log | observed outside the agent, tamper-evident to anyone holding a copy | the operator, who holds the key and the file |
| gateway, log run by someone else | tree heads signed by a key the operator does not hold | the log's operator, with yours |
| the same, with a witness | checkpoints countersigned by a second signer nobody in the chain controls | both operators and the witness, together |

The full list of claims, who can check each, and against whom, is the [proof table](/receipts/#what-a-receipt-proves-and-what-it-does-not). What the gateway does not cover is on the [deployment page](/guide/deployment#what-the-gateway-does-not-cover). A hosted log is [running and taking its first tenants](/early-access).

## Two packages

**[Receipts](/receipts/)** is what an agent did: the gateway, the in-process SDK, the log, and the verifier. A receipt names the tool, the arguments, the outcome, the policy decision, and the grant, with every field labelled `attested`, `observed`, or `claimed`.

**[State](/state/)** is what an agent believes: a fact ledger where every belief cites its receipt, can be superseded or retracted without losing history, and can be forgotten with a receipt as the certificate. `explain` answers, for one receipt id, [the questions a security owner asks](/state/#explain-one-action).

The ledger is a JSONL file, SQLite, or your Postgres. Recall stays in Mem0 or Zep through write-through adapters. Agents in Python, Go, Java, and Rust reach the gateway too.

## Install

::: code-group

```bash [npm]
npm install @agent-custody/receipts @agent-custody/state
```

```bash [Python]
npm install -g @agent-custody/receipts      # the command line and the sidecar, a Node process the Python package talks to
pip install agent-custody                    # the Python package: the sidecar client, the adapters, the memory client
```

:::

[GitHub](https://github.com/ch4r10t33r/agent-custody) · [npm](https://www.npmjs.com/package/@agent-custody/receipts) · [PyPI](https://pypi.org/project/agent-custody/) · Apache-2.0. [What each piece is for](/guide/pieces), when you need to choose.

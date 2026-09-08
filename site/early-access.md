---
title: Early access
---

# Hosted log: early access, not yet running

Everything on this site runs on your own machines today. The one thing you cannot run yourself is a log that is not yours: a transparency log operated by someone who is not the agent's operator, whose key signs the tree heads, so an auditor, a customer, or a regulator can accept a receipt without trusting you. That is the first hosted piece of agent-custody. It is not built yet, and nobody is on it; [issue #6](https://github.com/ch4r10t33r/agent-custody/issues/6) tracks it. Early access means telling us you want to be a first tenant, and shaping what gets built.

What you can do today, without us: run the reference log server from the receipts package on a machine your agent's operator does not control, and point the gateway at it with `log` in the config. That gives you tree heads signed by a key the operator does not hold, which is the whole point. [How](/receipts/usage).

What a hosted log would add, once it exists: a tenant with a bearer token per agent fleet, consistency proofs served, retention, and a public key you hand to whoever verifies your receipts. Nothing more is promised here; the shared memory server and the reports already exist as things you run yourself.

There is no price yet. The first tenants set it with us.

<ClientOnly><EarlyAccess /></ClientOnly>

Everything else, the gateway, the SDK, the ledger, the verifier, stays open source under Apache-2.0 and needs no account. [Get started](/guide/getting-started) with that today.

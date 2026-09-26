---
title: Early access
---

# Hosted log: taking the first tenants

Everything else on this site runs on your own machines. The one thing you cannot run yourself is a log that is not yours: a transparency log operated by someone who is not the agent's operator, whose key signs the tree heads, so an auditor, a customer, or a regulator can accept a receipt without trusting you.

That log is running at `log.agent-custody.dev` ([status](https://github.com/ch4r10t33r/agent-custody/actions/workflows/monitor.yml): a probe from machines that are not ours verifies it every ten minutes). It holds no receipts, only their hashes; its keys are published at [/.well-known/agent-custody-log.json](https://log.agent-custody.dev/.well-known/agent-custody-log.json) for verifiers to pin; and it publishes signed checkpoints to a second host, [checkpoints.agent-custody.dev](https://checkpoints.agent-custody.dev/default/latest.json), so a rewrite is detectable by someone who was not watching. We run our own receipts on it. Anyone can register a tenant at [app.agent-custody.dev](https://app.agent-custody.dev/) and get a log and a first key at once; the first tenants shape retention, jurisdiction, and what the reports should say.

What a tenant gets: a log of their own at `/t/<tenant>/`, a bearer token per fleet, a log id their tree heads carry, a welcome sheet with the one config line and the two verifier commands, and a dashboard showing appends against the plan, keys, the latest checkpoint, and every action taken on the tenant. What a tenant does not get yet, said plainly: a second independent signer (the witness, [issue #6](https://github.com/ch4r10t33r/agent-custody/issues/6)) or a contract with service levels. Read the [proof table](/receipts/#what-a-receipt-proves-and-what-it-does-not) before repeating any claim about it.

Prefer to run it yourself? The same server is a [container, a compose file, and Kubernetes manifests](https://github.com/ch4r10t33r/agent-custody/tree/main/deploy), and everything the hosted one does, yours does too.

Free is ten thousand appends a month; Team is $50 a month for a million; Enterprise is a conversation. The [pricing page](/pricing) has the table and what is not promised on any plan.

<ClientOnly><EarlyAccess /></ClientOnly>

Everything else, the gateway, the SDK, the ledger, the verifier, stays open source under Apache-2.0 and needs no account. [Get started](/guide/getting-started) with that today.

For your security team: the [security questionnaire](/security), the [threat model](/receipts/threat-model), and the [compliance mapping](/receipts/compliance).

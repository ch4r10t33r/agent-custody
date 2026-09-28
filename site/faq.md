---
title: FAQ
description: Where the gateway sits, what a receipt contains, what reaches the hosted log, and how secrets and personal data are handled.
---

# Frequently asked questions

Answers about where the data goes. Everything here is checkable against the code and the [threat model](/receipts/threat-model); where something is not built yet, it says so.

## Is agent-custody a proxy between the LLM and my tools?

Between the agent and its tools, yes. Between the agent and the model, no.

The gateway is an MCP server that stands in front of your real tools. The agent's framework sends it tool calls; it checks the grant and the policy, forwards or denies, and issues a receipt. Prompts, completions, and the model's reasoning never pass through it, because the model traffic is not routed through the gateway at all. It sees a tool call only when the agent makes one.

The gateway runs on your machines. Nothing in it phones home.

## What does a receipt contain? Is there personal data in it?

A receipt records the call as the tool saw it: the tool name, the arguments the agent sent, the facts the gateway fetched itself, the policy decision with the policy's hash, the grant that authorized the agent, and, for a call that ran, the result the tool returned. Every field is labelled `attested`, `observed`, or `claimed`.

So yes: if the agent passes a customer's email as an argument, or the tool returns an account record, that is in the receipt. A receipt is evidence of what happened, and the arguments and the result are what happened. Treat the receipts directory the way you treat the tool's own logs: it lives on your infrastructure, under your retention rules, and it never leaves unless you send it.

## What reaches the hosted log?

For each receipt, thirty-two bytes: the SHA-256 of the signed envelope. With it, the time it arrived, your tenant id, and the hash of the API key that sent it. The log stores that, signs tree heads over it, and publishes checkpoints.

This is enforced on the server, not left to configuration. The hosted log runs in hash-only mode and refuses a full receipt at append with a 400. The [security questionnaire](/security) says so, and the [privacy page](/privacy) lists everything the service holds. A hash of a signed receipt reveals nothing about its contents and cannot be linked to a person without the receipt itself.

The same hash is what a verifier checks: the inclusion proof ties the receipt you hold to the leaf the log holds. The log never needs the receipt to prove it was there.

## Does the gateway see my API keys and secrets?

It holds the credentials it needs to reach your tools, the same way any process that calls them does, and it reads them from the environment at startup: an upstream's header token, the log's API key, a webhook secret. They are never written into the configuration file, never written into a receipt, and never sent anywhere but to the service they belong to.

What a receipt does record is what the agent sent as arguments. If an agent passes a secret as a tool argument, it is in the receipt, exactly as it would be in any log of that call. The fix is the same as for any logging: do not hand secrets to agents as arguments; give the tool its credentials and let the agent ask for the action.

## Can I keep arguments and results out of receipts and track actions only?

Not yet as a switch. Today a receipt carries the full arguments and the result, plus a digest of the arguments that the verifier checks. A digest-only mode, where the receipt keeps the digests and the tool name and the full values stay in your own store, is designed but not built. It is tracked as [issue #76](https://github.com/svayatta/agent-custody/issues/76). Say there if you need it and what you would want kept.

What already sends actions only: the exporters. The OpenTelemetry and Splunk exporters emit one span or event per receipt with the receipt id, tool, agent, principal, decision, policy digest, argument digest, and log position. No arguments, no results. A trace backend or a SIEM sees that a refund was denied and which policy denied it, not the customer's details.

## Does the gateway call any AI service?

No. Policy evaluation is Cedar, evaluated in the gateway's process. The only network calls it makes are the ones you configure: to your own tools, to the log you name, and to the exporters you turn on. It runs offline against local tools and a local log file.

## What about prompt injection?

The gateway does not read prompts, so it cannot detect an injection. It does not need to. An injection that succeeds makes the agent call a tool it should not; the gateway evaluates that call against the policy and the facts it fetched itself, and denies it before the tool hears anything. The denial is a receipt with the arguments the agent tried, which is what your investigation wants. The film on the home page shows exactly this case.

## Who can read the portal and the admin page?

The portal at app.agent-custody.dev holds your account, your tenant, hashed API keys, usage counts, and the policy versions you chose to publish. The admin page is ours, behind one secret, and shows tenants, usage, and the contact details people gave at registration. Neither holds a receipt. The [privacy page](/privacy) is the full list.

## Can I run all of it myself?

Yes. The gateway, the SDKs, the ledger, and the verifier are Apache-2.0 and need no account. The log server is the same container we run, with a compose file and Kubernetes manifests in the [deploy directory](https://github.com/svayatta/agent-custody/tree/main/deploy). What you cannot run for yourself is a log operated by someone who is not you; that is the only thing the hosted service is.

## How do I delete what you hold?

Your tenant's leaf hashes, on written request; it is irreversible and breaks the inclusion proofs in your own receipts, which the runbook explains. Your account and contact details, on request. Receipts you never sent us, so there is nothing of them to delete here. For beliefs an agent recorded in the ledger, the state package's certified forget removes a value and issues a receipt saying what each store answered.

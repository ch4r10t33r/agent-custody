# Security

agent-custody exists to produce evidence that holds up against a hostile operator, so a flaw in it is a flaw in someone's evidence. Report one privately and we will treat it as the most important thing on the list.

## Reporting a vulnerability

Email **partha@charioteerconsulting.com**. Include what you found, how to reproduce it, and which version. You will get an acknowledgement within two working days and an assessment within seven. We fix confirmed issues in the packages and the hosted log before publishing anything about them, credit you in the changelog unless you prefer not, and do not pursue researchers who act in good faith and keep to their own tenants and data.

Do not open a public issue for a security problem.

## What is in scope

- The packages: `@agent-custody/receipts`, `@agent-custody/state`, and `agent-custody` on PyPI, at the current minor version.
- The hosted log at `log.agent-custody.dev` and its checkpoints host. Test only against a tenant that is yours.
- The browser verifier at agent-custody.dev/verify.

The [threat model](packages/receipts/docs/threat-model.md) lists every attacker the design answers and what it does not defend; a way to break one of its "evidence" rows is the report we most want. Issues of most interest: a receipt or tree head that verifies but should not, a way to make the gateway forward a call it should have denied or withheld, a way to append to another tenant's log or read its usage, a policy evaluation that allows what it should deny, and any way to reach the admin page or the signer without their tokens.

## For procurement

The [security questionnaire](https://agent-custody.dev/security) answers what a vendor review asks about the hosted log and the packages, with every "no" left as a no.

## Supported versions

The three packages move in lockstep. Security fixes go to the latest minor version; upgrading within a minor is a version bump. The receipt format is versioned separately (v0.2) and every published conformance vector must keep verifying, so an upgrade never invalidates existing evidence.

## How the pieces are protected

- Gateway and log keys are Ed25519; the signer alone holds the log's private key and the log signs through it. Retired public keys stay published so old heads keep verifying.
- Tenant tokens are stored as SHA-256 hashes; the plaintext is shown once at creation. The admin page and the signer each require their own token, presented from the environment, and wrong attempts are throttled per address.
- The hosted log holds leaf hashes only; receipts, arguments, and results never leave the tenant's machine.
- Secrets reach the gateway, the verifier, and the exporters through named environment variables, never as config values or flags.
- The container image is built by GitHub Actions from the published package and tagged by version. Releases to date were published to npm and PyPI by hand from the maintainer's machine; the release workflow publishes with provenance attestations through trusted publishing once the registries are configured for it, and this line will say so when it does.

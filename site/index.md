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
  - title: Beliefs with provenance and undo
    details: A bitemporal fact ledger where every belief cites the receipt that produced it, can be superseded or retracted, and answers what the agent believed at any moment.
    link: /state/
  - title: Any language
    details: TypeScript in-process, Python through a local sidecar with adapters for LangChain, OpenAI Agents, and the Claude Agent SDK, and forty-line clients in Go, Java, and Rust.
    link: /python/
  - title: Standard formats
    details: DSSE envelopes, in-toto statements, Ed25519, RFC 6962 hashing, RFC 9162 proofs. A verifier in another language needs nothing from here.
    link: /receipt/v0.2
---

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

<!--@include: ../README.md#pieces-->

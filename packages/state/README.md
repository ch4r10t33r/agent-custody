# @agent-custody/state

Governed memory for AI agents. Not a vector store: a ledger of facts where every write cites the receipt that caused it, carries valid time and transaction time, and can be superseded or rolled back without losing what the agent believed at any earlier moment.

Retrieval stays with whatever store you already use. This package owns provenance, time, and undo.

Nothing here yet beyond the package skeleton. The first pieces, in order: the fact record and JSONL ledger, as-of queries, supersession and rollback.

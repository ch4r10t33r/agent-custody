# Working in this repository

- **README.md must reflect every change before it is committed.** Check, at minimum: the intro, the doc links, the supported hosts table, the quick start, the layout block, and the Plan section (move finished items to Done, renumber Next). Do not commit code that the README describes differently.
- The guides under `docs/` are part of the change, not a follow-up. A new adapter, command, flag, or check gets documented in the same commit.
- Every Cedar example in `docs/policies.md` is executed by `test/docs-policies.test.ts`. Edit them together.
- Framework adapters are tested against the real package with a scripted model and no network. Do not add an adapter with only a hand-written stand-in.
- Record-only adapters evaluate no policy. Enforce or observe, never both on one tool.
- Money is integer minor units; Cedar has no floats.
- The CLI runs on plain Node 22 via native type stripping: no parameter properties, no enums, `.ts` import specifiers.
- Commit messages carry no attribution trailers.

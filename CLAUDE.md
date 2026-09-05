# Working in this repository

This is a Bun workspace. `packages/receipts` is the receipts package, `packages/state` is the governed-memory package. The root README lists packages and layout; each package has its own README. `bun run test`, `typecheck`, and `demo` at the root run across packages; the CLI and tutorials run from inside `packages/receipts`.

- **The READMEs must reflect every change before it is committed.** The package README for the package touched, and the root README when the layout or package list changes. In `packages/receipts/README.md` check, at minimum: the intro, the doc links, the supported hosts table, the quick start, the layout block, and the Plan section (move finished items to Done, renumber Next). Do not commit code that a README describes differently.
- The guides under `packages/receipts/docs/` are part of the change, not a follow-up. A new adapter, command, flag, or check gets documented in the same commit.
- Every Cedar example in `packages/receipts/docs/policies.md` is executed by `packages/receipts/test/docs-policies.test.ts`. Edit them together.
- Every file in `packages/receipts/examples/` is executed by `packages/receipts/test/examples.test.ts` and must end by printing `OK`. A new module or adapter gets an example and a row in `docs/tutorials.md` in the same commit.
- Framework adapters are tested against the real package with a scripted model and no network. Do not add an adapter with only a hand-written stand-in.
- Record-only adapters evaluate no policy. Enforce or observe, never both on one tool.
- Money is integer minor units; Cedar has no floats.
- The CLI runs on plain Node 22 via native type stripping: no parameter properties, no enums, `.ts` import specifiers. The state package imports the receipts package by subpath, `@agent-custody/receipts/src/<file>.ts`, the same way the docs show.
- Commit messages carry no attribution trailers.

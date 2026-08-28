---
id: P06
kind: task
status: ready
plan: ../plan.md
role: frontend
depends_on: [P02, P05]
write_scope:
  - front-end/src/training/
  - front-end/src/components/TrainingSidebar.svelte
  - front-end/src/__tests__/
---

# Connect the package-only frontend lifecycle

Submit the current `DiagramCore` package graph and typed training request,
surface validation/capability errors before queueing, observe authenticated
SSE/log/cancel state, and download only the verified wheel. Remove nntree
request helpers and the training ZIP branch once backend parity is present.

Acceptance: the UI cannot fabricate or submit an NNTree payload; package
identity, digest and wheel verification remain visible and actionable.

Validation:

```bash
pnpm --dir front-end check
pnpm --dir front-end test
pnpm --dir front-end guard:package-only
```

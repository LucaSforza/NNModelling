---
id: T02
kind: task
status: done
plan: ../plan.md
role: frontend
depends_on: [T01]
parallel_with: [T03]
write_scope:
  - front-end/
---

# Implement shared frontend authoring operations

## Objective

Make UI and browser RPC share create/delete operations for project stereotypes
and datasets, including a new confirmed stereotype-delete UI.

## Context required

Read the plan, UML parity decision, project-workspace stereotype decision,
project-owned dataset decision and browser-MCP architecture. Inspect the two
authoring coordinators, `FlowCanvas.svelte`, package manager/forms,
`BrowserRPCHandler`, project path adapter and focused tests.

## Invariants

- Browser project/DiagramCore owns live state; no second catalog or graph.
- Creation uses the existing request validators/generators and ordered writer.
- Stereotype deletion targets exact project identity and rejects core, in-use
  and dependency-required packages without mutation or cascade.
- Deletion updates disk, model manifest and live scope transactionally.
- Dataset create/delete continues to synchronize training and type catalogs.
- RPC data files decode from strict base64 before domain validation.

## Allowed files

Any file under `front-end/`, limited to the narrow authoring, UI, RPC and test
seams needed for this objective.

## Out of scope

MCP server code, dataset update over MCP, rename/move, backend archive deletion,
or unrelated known UI bugs.

## Work

1. Add stereotype delete transaction and regression coverage.
2. Extract/bind one frontend authoring service used by UI callbacks and RPC.
3. Add the stereotype confirmation UI and keep core rows immutable.
4. Add four browser RPC cases with exact result/error behavior.
5. Add focused frontend tests; T05 executes the planned gates.

## Acceptance criteria

- [x] Four RPC calls and UI calls reach the same coordinators.
- [x] Equivalent create requests produce identical domain resources.
- [x] Safe stereotype delete and existing dataset delete update live state.
- [x] Failure/cancellation has no partial visible or persistent success.
- [x] No changes outside `front-end/`.

## Validation

Executed during T05:

```bash
pnpm --dir front-end exec vitest run src/__tests__/projectStereotypeCreation.test.ts src/__tests__/projectDatasetAuthoring.test.ts src/__tests__/BrowserRPCHandler.test.ts
pnpm --dir front-end check
```

The focused authoring tests passed (10/10); the full frontend suite passed
(302/302) and `svelte-check` reported 0 errors.

## Required handoff

Handoff completed; T04 reviewed the integrated boundary and T05 passed final
automated and live-interface QA.

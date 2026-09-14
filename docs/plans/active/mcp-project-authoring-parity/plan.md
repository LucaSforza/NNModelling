---
id: mcp-project-authoring-parity
kind: plan
status: completed
updated: 2026-09-14
areas: [architecture, frontend, mcp, testing]
---

# MCP parity for project stereotype and dataset authoring

## Goal

Expose four project-authoring workflows through MCP—create/delete stereotype
and create/delete dataset—with the same semantic parameters, validation,
transactions and live editor effects as the visible frontend. Add stereotype
deletion to the UI and keep dataset deletion on the same shared operation.

## Delivered behavior

The frontend and browser-backed MCP expose shared project-scoped operations to
create and delete stereotypes and datasets. The UI and MCP paths use the same
validation, transactions, active package/dataset catalogs and rollback. Exact
project ownership is required for deletion; core, graph-used and
dependency-required stereotypes are protected. T05 final QA passed on
2026-09-14; see [the evidence](evidence/T05-final-qa.md).

## Scope

- Shared browser operations for all four use cases.
- UI confirmation and transactional deletion for project stereotypes.
- JSON-safe MCP transport for the frontend forms' complete semantic requests,
  including optional dataset data files.
- Exact public schemas, frontend RPC handling, MCP adapters and regression tests.

## Non-goals

- Dataset update through MCP, stereotype source-code editing, rename or move.
- Core stereotype deletion, cascading node deletion or dependency rewriting.
- Deleting immutable backend dataset archives or historical jobs.
- A second server-side package catalog, authoring generator or graph owner.

## Decisions and invariants

- The accepted behavior is defined in
  [MCP use-case parity](../../../knowledge/uml/mcp-use-case-parity.md).
- The active browser project and `DiagramCore` remain authoritative. UI and RPC
  call the same project coordinators; MCP performs only schema and transport
  adaptation.
- Create payloads preserve the exact semantic fields of
  `StereotypeAuthoringRequest` and `DatasetAuthoringRequest`. Dataset bytes use
  `{path, dataBase64}` only at the JSON boundary and become `Uint8Array` before
  domain validation.
- Delete payloads use exact `{id, version, path}` identity. Only project-owned
  resources are eligible.
- Stereotype deletion rejects packages referenced by graph nodes or required by
  another active custom package. It never cascades into nodes or dependencies.
- Dataset deletion preserves backend archives and jobs. Both deletions are
  transactional and preserve manifest, runtime/catalog state and unrelated
  files on failure.
- Create returns the created exact identity. Delete returns the deleted exact
  identity. Errors are truthful and do not report partial success.

## Contracts and control flow

```text
UI form/confirmation ─┐
                      ├─> shared FlowCanvas authoring service
MCP tool -> browser RPC┘       -> project coordinator -> ordered writer
                                               ├─> project directory
                                               └─> live package/dataset scope
```

Public operations are `create_stereotype`, `delete_stereotype`,
`create_dataset`, and `delete_dataset`. The MCP server validates their JSON
shape and forwards them to the selected browser tab. Domain defaults,
cross-field validation, package activation, dataset catalog updates and
rollback stay in the frontend.

## Task graph

| Task | Role | Depends on | May run with | Write scope | Outcome |
| --- | --- | --- | --- | --- | --- |
| [T01](tasks/T01-contract-and-kb.md) | architecture | — | — | This plan and current KB | Accepted four-operation contract |
| [T02](tasks/T02-frontend-shared-authoring.md) | frontend | T01 | T03 | `front-end/` | Shared UI/RPC CRUD behavior and frontend regressions |
| [T03](tasks/T03-mcp-authoring-tools.md) | integration | T01 | T02 | `mcp-server/` | Four public tools and proxy regressions |
| [T04](tasks/T04-integration-review.md) | review | T02, T03 | — | Read-only; fixes return to owners | Cross-boundary contract review |
| [T05](tasks/T05-final-qa.md) | integration | T04 | — | Disposable fixtures and evidence only | Passed real UI/MCP/filesystem QA |

## Integration and review gates

- T02 and T03 use the contract above and have disjoint write scopes.
- T04 checks schema/RPC agreement, shared browser ownership, exact destructive
  targeting and rollback. Findings return to the owning implementation task.
- The user resumed T05 after implementation fixes. Its automated and disposable
  live-interface gates passed; the evidence records the final runtime guard
  behavior and cleanup.

## Acceptance criteria

- [x] All four tools are discoverable and forward to the selected browser tab.
- [x] UI and MCP create equivalent stereotype/dataset project resources from
      equivalent semantic requests.
- [x] UI can delete project stereotypes with confirmation; UI and MCP dataset
      deletion share the same coordinator operation.
- [x] Core/in-use/dependency-required stereotype deletion is rejected without
      mutation; valid deletions remove exact project resources and live entries.
- [x] Failures preserve graph, manifest, active scope and unrelated files.
- [x] No MCP-side catalog, generator or graph state is introduced.
- [x] T05 was resumed and completed with passing evidence.

## Final verification

T05 ran these gates on 2026-09-14:

```bash
pnpm --dir front-end check
pnpm --dir front-end test
pnpm --dir front-end guard:package-only
pnpm --dir mcp-server test
git diff --check
```

It must also exercise create/delete for both resource types through the visible
UI and public MCP interface on a disposable project, compare disk/manifest/live
catalog state, reopen the project, and cover cancellation and rollback failure.

Results: frontend check passed with 0 errors and 35 warnings; frontend tests
passed (302); package-only guard passed; MCP tests/build passed (74); and
`git diff --check` passed. The live acceptance cases passed on a disposable
copy of the existing VAE project. Full details are in the T05 evidence.

## Knowledge and archive impact

The UML parity and browser-MCP coverage documents were updated with the
implementation. The related dependency-guard issue was reproduced, fixed and
verified through live MCP. T05 passed and this initiative is complete.

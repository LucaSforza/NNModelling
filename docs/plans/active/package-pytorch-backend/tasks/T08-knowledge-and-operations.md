---
id: T08
kind: task
status: superseded
plan: ../plan.md
superseded_by: ../../package-backend-standard/tasks/P07-verification-and-cleanup.md
role: documentation
depends_on: [T07]
parallel_with: []
write_scope:
  - docs/knowledge/
  - docs2/source/
  - converted/backend/README.md
---

# Align current knowledge and operator documentation

## Objective

Make current architecture, package, testing and local-operation documentation
describe the shipped package backend and its Podman/Docker execution boundary.

## Context required

- [Initiative plan](../plan.md)
- Completed implementation handoffs and T07 evidence.
- `docs/knowledge/README.md`
- `docs/knowledge/architecture/overview.md`
- `docs/knowledge/architecture/remote-training.md`
- `docs/knowledge/contracts/package-type-system.md`
- `docs/knowledge/operations/local-stack.md`
- `converted/backend/README.md`

## Invariants

- Document only behavior proven by implementation and T07 evidence.
- Keep the package runtime, Lua inference, MCP proxy, auth and container
  boundaries distinct.
- Document engine/socket privileges, image pinning, volumes, network policy,
  dataset policy, GPU status and cleanup without hiding limitations.

## Allowed files

- Current knowledge, public/operator documentation and backend README listed
  in `write_scope`.

## Out of scope

- New implementation changes or undocumented future marketplace behavior.
- Marking deferred GPU/network/package-trust choices as supported.

## Work

1. Update architecture and contract links for the package network variant.
2. Add operator setup for Podman first and Docker-compatible configuration.
3. Add testing boundaries and the real smoke-test path.
4. Re-read changed knowledge sections for contradictions and stale legacy
   claims.

## Acceptance criteria

- [ ] An operator can start the stack and understand which container runs each
      job and which volumes are writable.
- [ ] Current knowledge accurately distinguishes package and NNTree paths.
- [ ] Deferred or unsupported capabilities are explicitly labeled.

## Validation

```bash
git diff --check
```

## Required handoff

Return changed documentation paths, commands verified, links checked and any
remaining operational caveat.

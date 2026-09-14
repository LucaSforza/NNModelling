---
id: T01
kind: task
status: done
plan: ../plan.md
role: architecture
depends_on: []
parallel_with: []
write_scope:
  - docs/knowledge/uml/mcp-use-case-parity.md
  - docs/plans/active/mcp-project-authoring-parity/
---

# Fix the four project-authoring contracts

## Objective

Record the accepted UI/MCP parity, ownership and deletion-safety rules needed
for independent frontend and MCP implementation.

## Acceptance criteria

- [x] Four use cases and exact identities are explicit.
- [x] Shared browser ownership and JSON-only binary adaptation are explicit.
- [x] Destructive non-cascading and rollback rules are explicit.

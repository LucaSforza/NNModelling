# Architectural decisions

Store only decisions that remain relevant to current implementation choices.
Use one file per decision with context, decision, consequences, status, and
links to the affected contracts. Completed implementation plans and superseded
reasoning belong in `docs/archive/`.

Agent-facing modeling and training requirements are defined by
[MCP use-case parity with the editor](../uml/mcp-use-case-parity.md). This
accepted constraint must not be mistaken for a completed implementation.

Current package and project ownership is defined by:

- [model-scoped custom stereotype packages](model-scoped-stereotype-packages.md);
- [writable project workspaces and model-owned stereotype authoring](project-workspaces-and-stereotype-authoring.md);
- [project-owned datasets and named training batches](project-owned-datasets.md).

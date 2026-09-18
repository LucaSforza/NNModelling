---
name: use-stereotype-kb
description: Ground work in NNModelling's repository knowledge base and keep it authoritative. Use for architecture, implementation, refactoring, review, testing, or planning that affects the type system, stereotype packages, Lua or PyTorch runtimes, standard library, differential fuzzing, or NNModelling integration, and whenever current knowledge under docs/knowledge/ must be updated.
---

# Use the NNModelling knowledge base

Treat the repository's `docs/knowledge/` tree as the durable source of current
NNModelling knowledge. `docs/README.md` defines the documentation taxonomy and
`docs/knowledge/README.md` is its index. Keep accepted decisions out of
chat-only context and do not replace them with assumptions. The retired
`design/` and `docs/design/` trees are not valid knowledge-base locations and
must not be recreated.

## Read before acting

1. Read `docs/README.md` completely.
2. Read `docs/knowledge/README.md` completely.
3. Select every affected knowledge area under `docs/knowledge/`:
   `architecture/`, `contracts/`, `decisions/`, `operations/`, `testing/`, or
   `uml/`.
4. Read the selected area's directly relevant documents completely. There are
   no required per-area `README.md` files; use the knowledge index and document
   headers to select the current source.
5. Follow relative links only when they affect the task; do not load archived
   plans or unrelated topics merely for completeness.

For work spanning areas, read all affected areas. Integration work commonly
requires `architecture/`, `contracts/`, `decisions/`, and `testing/`.

## Classify the design state

Before changing code or architecture, classify each relevant point as:

- **agreed:** implement and preserve it;
- **open:** ask the user targeted questions before choosing;
- **deferred or non-goal:** do not implement it;
- **conflict:** surface the disagreement between code, documents, and observed
  NNModelling behavior.

Treat normative design as authoritative over the current implementation. When
code conflicts with an agreed rule, correct the code or report the blocker; do
not silently reinterpret the document.

Do not turn an example, backlog item, or question into a requirement. Do not
infer NNModelling architecture when repository evidence or user information is
available.

## Update the knowledge base

Update `docs/knowledge/` in the same task when the user accepts a material
architectural decision or when an operational/configuration change would make
current knowledge false.

1. Put the update in the narrowest existing area. Use `decisions/` for durable
   architectural choices, `architecture/` for system boundaries, `contracts/`
   for externally observable invariants, `operations/` for lifecycle,
   configuration and runbooks, `testing/` for QA contracts, and `uml/` for
   accepted use-case constraints.
2. Add a new document only when the subject needs its own durable contract;
   otherwise update the relevant current document and
   `docs/knowledge/README.md` when its index or scope changes.
3. Record invariants, boundaries, rationale, examples, open questions, and
   explicit non-goals—not a transcript of the conversation.
4. Label proposals and unresolved details honestly. Never mark a choice agreed
   unless the user accepted it.
5. Use relative links within `docs/knowledge/` and check that updates do not
   leave stale contradictory text. Historical reasoning belongs in
   `docs/archive/`, not in current knowledge.

Keep domain decisions in the KB rather than duplicating them in this skill. The
skill defines the workflow; the KB defines the architecture.

## Implement from the KB

Preserve unrelated user changes and inspect repository state before editing.
Make the smallest coherent implementation of the agreed scope. Add tests for
observable semantics and invariants, especially compositional behavior and
diagnostic preservation.

When the task concerns NNModelling, distinguish:

- reference semantics owned by `stereotype-lab`;
- candidate integration behavior owned by NNModelling;
- editor or transport details that must not leak into the type language.

Use the reference implementation as an oracle, not as a production dependency
of NNModelling.

## Finish the task

1. Run task-relevant tests and `git diff --check`.
2. Re-read every changed `docs/knowledge/` section for contradictions and
   accidental new commitments.
3. Report which KB documents changed and which questions remain open.
4. Commit only when the user asks, following the repository's commit rules.

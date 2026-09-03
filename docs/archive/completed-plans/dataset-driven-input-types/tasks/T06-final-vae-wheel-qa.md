---
id: T06
kind: task
status: done
plan: ../plan.md
role: verification
depends_on: [T05]
parallel_with: []
write_scope:
  - docs/plans/active/dataset-driven-input-types/evidence/
---

# Prove VAE training and wheel interpolation through real interfaces

## Objective

Open the migrated VAE example in NNModelling, train it through the supported
browser/backend path, download its wheel and prove public-API interpolation in
a clean consumer environment.

## Execution isolation

This task MUST run in a fresh dedicated top-level browser-owning execution
session after T05 completes. It MUST NOT run as a delegated child of the task
that implemented or integrated the change. The dedicated session owns the
supported in-app Browser for the entire workflow and records independent
evidence. The active orchestrator adapter defines how to create that session.

## Context required

- [Initiative](../plan.md) and T05 readiness handoff
- Migrated VAE diagram and `autoencoder-mnist` project dataset
- NNModelling browser/MCP and final-verification skills
- Public `examples/vae_mnist` consumer

## Invariants

- The VAE dataset is already migrated and passes static validation before this
  task begins.
- Use the supported in-app Browser and browser-owned DiagramCore; do not substitute
  external Chromium, direct file edits or backend-only submission.
- Use a fresh worker image/protocol accepted by the current backend.
- The downloaded wheel and its public APIs are the artifact under test.
- Product defects fail QA and return to the owning implementation task.

## Allowed files

Write only concise reproducible evidence under `write_scope`. Do not repair
product code or examples inside this QA task.

## Out of scope

- Implementing missing features, weakening assertions, using internal wheel
  modules or treating a smoke-only epoch as learning evidence.

## Work

1. Confirm the migrated VAE dataset has required dimension values, no legacy
   dataset adapter and no Input shape/dtype parameters.
2. Start/reuse the supported stack, open the VAE project through NNModelling,
   select its dataset and verify browser-visible resolved Input types with no
   hard diagnostics.
3. Configure and run a bounded but meaningful VAE training job to `succeeded`;
   inspect progress, loss behavior, worker protocol and diagnostics.
4. Download the selected-editor wheel and verify its byte count and SHA-256.
5. Install the wheel into a clean temporary consumer environment with no
   NNModelling checkout on `PYTHONPATH`.
6. Run the public VAE interpolation flow using only declared wheel adapters,
   generate interpolation output and visually inspect it.
7. Record job identity, dataset identity/parameters, resolved input contract,
   worker image/protocol, wheel hash, commands/results and inspected image path.

## Acceptance criteria

- [ ] The migrated VAE opens and resolves its Input from the selected dataset.
- [ ] Browser-submitted training reaches `succeeded` with useful learning evidence.
- [ ] The selected-editor download produces a verified wheel.
- [ ] A clean environment imports the installed distribution without repository dependencies.
- [ ] Public wheel adapters perform interpolation without dataset access or internal model access.
- [ ] Generated interpolation output is visually inspected and quality is reported honestly.
- [ ] Evidence is reproducible and contains no credentials, tokens or wheel bytes.
- [ ] No changes outside `write_scope`.

## Validation

```bash
uv run --project examples/vae_mnist pytest -q
git diff --check
```

Browser, training, wheel installation and interpolation evidence are mandatory;
the command gate alone cannot satisfy this task.

## Required handoff

Return browser journey, job/dataset identities, parameter values, resolved
types, image/protocol, wheel hash, clean-environment commands/results, public
adapter calls, inspected output path and any blocker or quality limitation.

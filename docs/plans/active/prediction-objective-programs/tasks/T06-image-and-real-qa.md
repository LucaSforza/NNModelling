---
id: T06
kind: task
status: ready
plan: ../plan.md
role: integration
depends_on: [T02, T04, T05, T07, T08]
parallel_with: []
write_scope:
  - converted/backend/
  - converted/src/backend/
  - converted/src/tests/test_backend_e2e.py
  - front-end/src/__tests__/
  - examples/vae_mnist/
  - examples/resnet_mnist/
  - docs/plans/active/prediction-objective-programs/evidence/
---

# Version the worker image and prove real workflows

## Objective

Prevent stale worker semantics and verify ResNet and VAE from the browser
through downloaded, clean-environment wheels.

## Context required

- [Package backend security decision](../../../../knowledge/decisions/package-backend-standard.md)
- [Accepted execution decision](../../../../knowledge/decisions/prediction-objective-programs.md)
- T02, T04 and T05 handoffs
- NNModelling browser/MCP and final-verification skills

## Invariants

- FastAPI never executes package Python.
- Browser-submitted code runs only in the constrained Podman/Docker worker.
- The configured image is immutable by digest and reports a versioned worker
  execution protocol.
- QA uses the public UI and downloaded wheel APIs, not artifact-directory
  shortcuts as the acceptance proof.
- This integration task may change only worker protocol/deployment glue and the
  VAE example. It must not modify the compiler, trainer, package definitions,
  frontend graph semantics or wheel exporter; failures in those areas return
  to T01–T05 for a reviewed fix and targeted tests.

## Work

1. Add a request/worker execution-protocol version and typed mismatch error.
2. Add tests proving an old protocol fails before package compilation.
3. Build a fresh worker image, record its digest and verify Podman and Docker
   command parity with fake-engine tests before real-engine smoke checks.
4. Through the Codex in-app Browser, train the explicit-loss ResNet on bounded
   MNIST for a meaningful number of epochs, and download its wheel.
5. Through the same UI, train the explicit-output VAE and download its wheel.
6. Install each wheel as a dependency of a clean temporary `uv` project.
   Import `Model` directly from its declared `nnm_<suffix>` package and verify
   ResNet logits and VAE reconstructions without the checkout on `PYTHONPATH`.
7. Rewrite the VAE and ResNet examples as standalone `uv` consumer projects
   following the [model-package example
   contract](../../../../knowledge/contracts/model-package.md). Do not use
   wheel-path import tricks, redundant package-name arguments or resources
   from `converted/`.
8. Verify evaluation reconstruction twice with identical inputs and verify
   that stochastic latent sampling is available only through the selected,
   declared adapter. Record loss curves and inspected image paths.
9. Add a ResNet example using only its installed wheel and demonstrate logits
   on a small input fixture, confirming the exported state is the completed
   browser job's state.

## Out of scope

- Opportunistic compiler, trainer, frontend-semantic or exporter fixes during
  QA.
- Treating an unavailable container engine or browser download event as a
  successful test.

## Acceptance criteria

- [ ] Browser job logs expose the expected worker protocol and immutable image
      digest.
- [ ] ResNet and VAE jobs reach `succeeded` with explicit objectives.
- [ ] Both jobs run enough epochs to assess learning rather than only worker
      startup; curves and outputs are reviewed.
- [ ] Both browser download controls produce verified wheels.
- [ ] Clean installs pass the output-shape assertions without targets.
- [ ] Both examples import `Model` from the installed distribution and contain
      no checkout runtime, data dependency or internal model access.
- [ ] Actual image outputs are visually inspected and poor results are reported
      rather than described as successful interpolation.
- [ ] Deterministic VAE evaluation and explicit stochastic-adapter behavior are
      exercised through the downloaded wheel.

T09 has focused Python and clean-wheel coverage, but no browser submission,
download and installed-wheel exercise for a selected adapter has been recorded
yet. That end-to-end proof remains pending and is not inferred from the unit
tests.

## Validation

```bash
cd converted && uv run pytest src/tests/test_backend_e2e.py -q
pnpm --dir front-end test
pnpm --dir front-end check
git diff --check
```

## Required handoff

Return job IDs, image digest/protocol, browser-visible statuses, wheel hashes,
clean-environment commands and results, inspected image paths, engine
availability and any limitation that prevented a real Docker or Podman run.

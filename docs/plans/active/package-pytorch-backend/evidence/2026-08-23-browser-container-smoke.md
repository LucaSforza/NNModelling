---
kind: verification-evidence
plan: ../plan.md
date: 2026-08-23
status: partial
---

# Browser-to-container smoke test

## Environment

- Frontend: `http://127.0.0.1:5174/`, controlled through the Codex in-app
  Browser.
- Backend: `http://127.0.0.1:8000/`, Valkey on the local development port.
- Engine: Podman, with the digest-pinned local worker image
  `localhost/nnm-worker@sha256:d4ddff281c03c11b1a1f3c63db9d9da047f220b12c0210c0fe59b412c25447cb`.
- Diagram: `examples/diagrams/package/variational-autoencoder-complete.json`.

## Real interface result

The browser loaded the VAE diagram, selected `AutoencoderMNIST`, uploaded the
package bundle, submitted `network.format: "package"`, and observed the job
through the existing authenticated Training sidebar. The successful job was:

`ce21b38b-24c6-4957-91dd-7ab123e9feef` — `succeeded`, executor `container`.

Configuration was one epoch, `train_size=0.01`, batch size 128 and zero data
loader workers. This is a bounded smoke test, not a quality or convergence
benchmark.

Artifacts were produced under the job directory:

- `training-summary.json`: dataset `dataset.autoencoder_mnist.AutoencoderMNIST`,
  431,504 parameters, train loss `0.7210757536093394`, validation loss
  `0.7129320569038391`.
- `weights.safetensors`: 1,727,584 bytes.
- `stdout.log`: one JSON epoch record; `stderr.log` was empty.

## Gates

- `pnpm --dir front-end test`: 115 passed.
- `pnpm --dir front-end check`: 0 errors, 9 pre-existing warnings.
- `PYTHONPATH=src UV_CACHE_DIR=/tmp/nnm-uv-cache uv run pytest src/tests/ -m fast -q`:
  200 passed, 20 deselected, 2 warnings.
- Focused backend package/API/container tests: 54 passed.

## Remaining verification

This evidence does not claim GPU support, Docker execution, full MNIST training,
or verified model-wheel download. Invalid-package ownership and cancellation
cases remain follow-up coverage before the plan is closed.

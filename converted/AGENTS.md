# Python conversion and runtime agent guidance

Applies to `converted/`. Inherit repository-wide rules from `../AGENTS.md`.

## Stack and commands

Use Python style, testing, and PyTorch repository skills when their trigger
conditions apply. Run commands from `converted/` unless noted otherwise:

```bash
uv run python src/convert.py <nntree_json> <output_dir>
uv run python src/main.py --config-dir <dir>
uv run python src/infer.py --config-path <dir> --config-name <name> --weights <path>
uv run pytest src/tests/ -m fast -q
```

Use focused pytest files while iterating. The `fast` suite excludes service and
training-heavy coverage. `service` uses real Valkey, `e2e` exercises canonical
backend jobs, and `legacy_e2e` is optional real MNIST training.

## Conversion and runtime contracts

- `src/convert.py` converts NNTree JSON into Hydra configuration groups. It
  parses parameter strings safely, emits `_target_` paths, and uses
  `_recursive_: false` for subflow configs.
- `src/net/base.py` dynamically builds the Lightning `ModuleDict` and executes
  nodes in topological order.
- Flattening is explicit through the Flatten stereotype; do not restore an
  automatic flatten heuristic.
- Join inputs must follow the NNTree `inputs` order derived from browser
  `targetHandle`, not BFS discovery order.
- `src/ops/subflow.py` executes internal topology, `repeat.py` creates sequential
  copies with independent weights, and `horizontal_repeat.py` performs parallel
  copies with its documented final-dimension concatenation.
- The editor models Loss output conceptually as `[B]`, while the current runtime
  treats Loss nodes as terminal training objectives. Do not silently conflate
  these behaviors when extending runtime propagation.
- Dataset classes may expose static `num_classes(config)` and
  `class_names(config)` metadata without loading data.
- Classification-only whole-test-set metrics and W&B charts must stay guarded by
  task type; regression and autoencoder paths must not emit them.

## Remote training backend

`src/backend/` contains FastAPI endpoints, Valkey persistence, scheduling,
executors, artifact management and startup recovery. Deployment assets live in
`backend/`.

- Default artifacts live under `jobs/<job-id>/`; deployments may override this
  with `NNM_BACKEND_ARTIFACT_ROOT`.
- Preserve priority/FIFO scheduling, heartbeats, cancellation and recovery
  semantics when changing persistence or executors.
- Local and Slurm executors share the executor contract. Slurm may submit locally
  or over SSH.
- A completed job exports a wheel with resolved graph, required operations,
  declarative input adapter and safetensors weights.
- The backend independently resolves dataset metadata and rejects contradictory
  manual class counts.

For a local backend, follow the commands and lifecycle documented in the root
reference or the `nnmodelling-mcp` skill rather than improvising port cleanup.

## Testing expectations

- Add focused tests under `src/tests/` for converter, ops, runtime, inference or
  backend changes.
- Reuse NNTree fixtures from `../examples/nntrees/`.
- Changes that affect generated configs should be checked both with Python tests
  and the relevant frontend integration tier.
- Training, datasets, network downloads, Valkey and Slurm are separate slow or
  external boundaries; mock them in unit tests and run real tiers only when the
  requested behavior requires it.

Detailed history and architecture remain in `../docs/agent-reference.md`.

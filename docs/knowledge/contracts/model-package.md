---
kind: knowledge
status: current
updated: 2026-08-12
---

# Portable model-package contract

A successful training job may produce a deterministic pure-Python wheel for
inference without the NNModelling checkout, Lightning, W&B or the training
dataset.

## Inputs and outputs

`build_model_wheel()` requires a resolved configuration and a valid non-empty
`weights.safetensors`. The package name must match
`nnm_[A-Za-z][A-Za-z0-9_]*`.

The job artifact contains:

```text
weights.safetensors
resolved_config.yaml or resolved_config.json
model-package.json
dist/nnm_<name>-<version>-py3-none-any.whl
```

The manifest schema records package name, version, relative wheel path, SHA-256
digest and declarative input-adapter specification. The API streams the server-
selected wheel after checking job ownership; clients do not provide filesystem
paths.

## Wheel contents

- rewritten architecture with package-local custom operation targets;
- safetensors weights;
- inference runtime and trusted input-adapter registry;
- standard wheel metadata and RECORD hashes.

Public API:

```python
from nnm_example import load_model

model = load_model(device="cpu")
output = model.predict_tensor(batch)
output = model.predict(value)
```

`predict_tensor` is the universal tensor boundary. `predict` uses the packaged
adapter specification. Adapters are declarative; the browser cannot inject
Python code into a package.

The exporter is `converted/src/model_package/exporter.py`; runtime and adapters
live beside it. Full-path verification is in
`converted/src/tests/test_backend_e2e.py`.

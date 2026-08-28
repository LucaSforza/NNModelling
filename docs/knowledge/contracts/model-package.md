---
kind: knowledge
status: current
updated: 2026-08-27
---

# Portable model-package contract

A successful package-native training job produces a deterministic pure-Python
wheel for inference without the NNModelling checkout, Hydra/OmegaConf,
Lightning, W&B, or the training dataset.

## Artifact and wheel contents

`build_model_wheel()` requires the validated package bundle used by the worker
and a non-empty `weights.safetensors`. Resolved NNTree/Hydra configurations are
not accepted. The artifact contains:

```text
weights.safetensors
package.json
training-summary.json
model-package.json
dist/nnm_<name>-<version>-<wheel>.whl
```

The wheel embeds the package graph, package dependency closure and restricted
package compiler/runtime needed to build it. It also contains the safe tensor
state and declarative input-adapter specification. It does not embed objective
execution: the architecture declares the prediction program, and the runtime
loads the shared trained state into that prediction view.

The manifest records package name, version, relative wheel path, SHA-256
digest, and adapter specification. The backend streams the server-selected
wheel after checking job ownership; clients cannot provide filesystem paths.

## Public API

```python
from nnm_example import load_model

model = load_model(device="cpu")
output = model.predict_tensor(batch)
output = model.predict(value)
```

`predict_tensor` accepts an already-preprocessed batch and invokes only the
explicit prediction program. It never requires, fabricates, or infers a
dataset target; objective nodes such as Cross Entropy, MSE, and KL are not
executed. `predict` uses the packaged adapter specification. Adapters are
declarative, so the browser cannot inject Python code into a package.

Safetensors are restored with strict state-dict loading against the one shared
compiled module store. A missing, extra, or incompatible tensor therefore
fails package loading instead of silently producing a partially initialized
model.

The exporter is `converted/src/model_package/exporter.py`; runtime and
adapters live beside it. Full-path verification is in
`converted/src/tests/test_model_package.py` and
`converted/src/tests/test_backend_e2e.py`.

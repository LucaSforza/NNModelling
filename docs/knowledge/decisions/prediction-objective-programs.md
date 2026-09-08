---
kind: decision
status: accepted
updated: 2026-08-27
---

# Separate prediction and objective programs

## Context

A package diagram may contain both the computation needed at inference time
and training-only objective nodes. A dataset supplies model inputs and targets,
but targets are not ordinary model tensors and are unavailable when a portable
wheel performs inference.

The experimental package runtime currently conflates these concerns. It may
execute a terminal loss inside model `forward()`, infer a loss from output
shape and target dtype, or inspect a Python callable to decide whether to pass
a target. These behaviors make the same graph mean different things in the
trainer and wheel, special-case particular PyTorch classes, and can make a
trained classifier impossible to invoke without a target.

The historical NNTree runtime kept prediction and loss execution separate,
but represented the objective as one global `lossNode`. The separation was
useful; the singleton NNTree/Hydra representation is not part of the package
standard.

## Decision

The package compiler produces two views over one compiled module graph:

- **PredictionProgram** executes the data path required by the graph's explicit
  prediction output and never requires dataset targets.
- **ObjectiveProgram** executes the shared data path plus the objective region,
  binds declared external batch values, and returns the final scalar training
  objective.

The views share one module store and one parameter set. Compilation must not
instantiate or train duplicate copies of model layers. During training the
objective program may retain and reuse intermediate values required by loss
branches. The portable wheel invokes only the prediction program.

Targets remain owned by the selected, validated dataset contract. A normalized
training batch has flat named `inputs` and `targets` tensor maps at the worker
boundary. Targets are not represented by normal graph edges or top-level model
inputs.

## Dataset-owned training settings

Dataset-specific settings are part of the registered dataset schema, not a
second global training configuration. In v1 this includes batch size, worker
count and split policy. The browser selects a dataset and submits only values
accepted by that schema; the worker validates and serializes the schema once.
Duplicated global fields, Hydra-style overrides, and silent precedence between
dataset and global values are invalid.

Evaluation is deterministic for stochastic model components. A VAE
reparameterization uses its mean in eval mode; random latent sampling is an
explicitly declared wheel adapter with a versioned randomness policy, never an
implicit behavior of prediction.

## Declarative objective bindings

Every package with `kind: "loss"` declares its external objective inputs in
`stereotype.json`. A binding selects one declared target slot:

```json
{
  "kind": "loss",
  "objective": {
    "externalInputs": [
      { "name": "target", "source": "batch.targets.target" }
    ]
  }
}
```

Cross Entropy and MSE use that declaration. A target-independent contribution
such as Gaussian KL divergence declares an empty list:

```json
{
  "kind": "loss",
  "objective": { "externalInputs": [] }
}
```

The runtime passes graph-edge operands first in `targetHandle` order, followed
by the declared external inputs in declaration order. Each external input name
and source may occur at most once per objective node in v1, and each declaration
produces exactly one positional module argument. Missing, unknown or duplicate
bindings are validation errors before training starts. The runtime does not
inspect Python signatures to discover this contract.

Input and target slots are flat named tensor maps. Sources use one validated
slot name after `batch.inputs.` or `batch.targets.`; v1 does not interpret
arbitrary object paths or nested Python structures. The complete batch contract
is defined by the
[project-owned dataset decision](project-owned-datasets.md).

An external input may also declare a versioned, data-independent adaptation
before it is passed to the objective. The current v1 adaptation is
`flatten_batch`, which preserves dimension zero and flattens all remaining
dimensions. This is useful when a reconstruction objective's model branch
declares a flattened output while the dataset exposes image-shaped targets:

```json
{ "name": "target", "source": "batch.targets.target", "transform": "flatten_batch" }
```

The adaptation belongs to the objective package declaration, not to a
package-ID branch, output-shape heuristic, or dataset-specific worker rule.

## Graph roles and partitioning

Prediction output is explicit and package-driven. A standard-library identity
package with `kind: "output"` marks the one v1 prediction result. Trainable
graphs branch the prediction tensor to both this output and the applicable loss
node. Package kind, never package ID or display name, determines the role.

The objective region consists of every `kind: "loss"` node and every node
reachable from a loss by following directed edges from `source` to `target`.
This permits target-independent contributions and ordinary scalar joins, such
as adding reconstruction and KL losses. A v1 trainable graph has:

- one or more top-level inputs with distinct batch binding names;
- exactly one prediction output outside the objective region;
- exactly one terminal value in the objective region.

Both terminals and every node contributing to them must be reachable from the
top-level input. Every objective join must have all declared graph operands
connected and reachable. Disconnected losses, disconnected outputs, outputs
inside the objective region and multiple objective terminals are invalid.

An inference-only graph may omit the objective region. A graph submitted for
training may not omit either the prediction output or final objective.

The frontend's current single-terminal rule must be replaced by these
role-aware completion rules when this decision is implemented. Lua remains the
authority for tensor propagation; Python is not a type-inference fallback.

## Forbidden behavior

The compiler, trainer and wheel must not:

- choose loss semantics from output rank, shape or dtype;
- select Cross Entropy, MSE or another objective as a trainer fallback;
- switch on package IDs, display names or Python module classes;
- use `isinstance(..., torch.nn.*Loss)` to route execution;
- inspect a Python callable signature to decide whether a target is required;
- substitute the original model input when a target is absent;
- infer the prediction output by walking backward from a loss;
- execute an objective from `predict()` or `predict_tensor()`.

The existing `_loss()` shape/dtype dispatcher and `_invoke_objective()`
signature dispatcher are transitional defects and must be removed, not
generalized.

## Dataset and type boundary

Built-in and project-owned datasets declare the tensor contract for named
`inputs` and `targets`. The worker normalizes each dataset item to the versioned
training-batch contract before invoking compiled programs. Top-level Input
nodes and package objective bindings may consume only names declared by that
contract.

The standalone diagram can validate model-side operands without selecting a
dataset. Once a dataset is selected for training, its registered target spec
is checked against the objective binding before the job enters its epoch loop.
This cross-contract validation does not add dataset code or target edges to the
diagram type language.

## Consequences

- A trained wheel has the same prediction semantics whether or not its source
  diagram included training objectives.
- Cross Entropy, MSE, KL and composite objectives use one data-driven runtime
  mechanism.
- The VAE may export decoder reconstruction while training through a separate
  MSE-plus-KL objective graph.
- Existing diagrams must add an explicit output marker; there is no permanent
  compatibility fallback that guesses the output.
- Worker images must version this execution protocol so an old image fails
  with a typed compatibility error instead of running stale semantics.

## Related contracts

- [Package backend standard](package-backend-standard.md)
- [Frontend package type system](../contracts/package-type-system.md)
- [Portable model packages](../contracts/model-package.md)
- [Prediction/objective implementation plan](../../plans/active/prediction-objective-programs/plan.md)

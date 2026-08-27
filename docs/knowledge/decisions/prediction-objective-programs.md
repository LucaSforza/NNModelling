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

Targets remain owned by the selected, trusted dataset contract. A training
batch has explicit `inputs` and `targets` fields at the worker boundary. A
target is not represented by a normal graph edge or a second top-level model
input.

## Declarative objective bindings

Every package with `kind: "loss"` declares its external objective inputs in
`stereotype.json`. The v1 binding source is `batch.targets`:

```json
{
  "kind": "loss",
  "objective": {
    "externalInputs": [
      { "name": "target", "source": "batch.targets" }
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

Named or structured multi-target batches are deferred. Adding them requires a
new versioned binding source; v1 does not interpret arbitrary object paths.

## Graph roles and partitioning

Prediction output is explicit and package-driven. A standard-library identity
package with `kind: "output"` marks the one v1 prediction result. Trainable
graphs branch the prediction tensor to both this output and the applicable loss
node. Package kind, never package ID or display name, determines the role.

The objective region consists of every `kind: "loss"` node and every node
reachable from a loss by following directed edges from `source` to `target`.
This permits target-independent contributions and ordinary scalar joins, such
as adding reconstruction and KL losses. A v1 trainable graph has:

- exactly one top-level input;
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

Registered datasets declare the tensor contract for both `inputs` and
`targets`. The worker normalizes a registered dataset batch to the versioned
training-batch contract before invoking compiled programs. Package objective
bindings may consume only sources allowed by that contract.

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

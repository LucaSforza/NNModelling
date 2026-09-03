---
kind: decision
status: accepted
updated: 2026-09-03
---

# Dataset-driven model input types

## Context

`core.input` currently stores `shape` and `dtype` as stereotype parameters.
The selected dataset separately declares the same tensor information for each
named input slot, so training compares two user-maintained descriptions of the
same boundary. This makes a diagram independently typable, but duplicates the
training data contract and makes changing datasets require editing Input nodes.

NNModelling instead treats a diagram as a family of models. Selecting a dataset
and its parameter values instantiates that family for type inference,
compilation and training. It is acceptable for Input-dependent regions to
remain unresolved while no dataset is selected and for a different dataset to
produce a different valid model instance.

## Decision

A top-level `Input` node declares only its stable named `inputBinding`.
`core.input` has no `shape` or `dtype` parameters. During dataset-scoped type
inference, the bound entry in `dataset.batch.inputs` is the sole authority for
the Input node's tensor shape and dtype.

Every symbolic dimension used by a dataset input or target slot MUST name an
existing dataset parameter with the same spelling. That parameter MUST have
type `integer`, and the resolved dataset selection MUST assign it a positive
integer before complete inference, validation, compilation or training. The
existing dataset parameter mechanism is the metavariable environment; v1 adds
no separate metavariable declaration, expression language or role taxonomy.

`B` follows the same declaration and resolution rule and represents the
dataset's batch-size parameter. Training uses its resolved value. An exported
wheel records the resolved input contract but preserves the leading batch axis
as dynamic, so an artifact trained with one batch size is not restricted to
that batch size during inference.

Changing the selected dataset or any dimension-valuing parameter invalidates
the previous dataset-scoped inference result and recompiles the model. Existing
checkpoint compatibility remains strict: weights may be reused only when the
resulting architecture fingerprint and state tensor contracts still match.

The portable wheel does not contain or require the training dataset. It embeds
the resolved named input contract needed by `predict_tensor()` and the existing
stereotype-selected wheel adapters needed by `predict()`. Input preprocessing
is model behavior and therefore belongs to those model/package adapters, not
to dataset metadata. Removing the legacy dataset `inferenceAdapter` field is a
migration step in the implementation plan, not a second adapter design.

Internal subflow boundaries do not bind dataset slots directly. Their types
continue to come from the enclosing graph edge or subflow contract. Only
top-level model Inputs use dataset resolution.

## Validation states

The editor distinguishes these states:

- **structurally valid, dataset unresolved**: topology and local parameters are
  valid, but Input-dependent tensor inference is waiting for a dataset;
- **dataset invalid**: a binding, dtype, symbolic parameter or positive value
  is missing or malformed;
- **dataset-scoped model valid**: every required named tensor and dimension is
  resolved and the complete graph is type-correct;
- **exported**: the wheel contains an immutable resolved input contract and no
  dependency on the selected dataset.

Absence of a selected dataset is unresolved editor state, not a fabricated
tensor and not by itself a malformed graph.

## Consequences

- One diagram can be retrained with datasets that expose compatible binding
  names but different shapes, dtypes and dimension values.
- Dataset selection becomes required for complete Input-dependent inference,
  compilation and training.
- Model export remains dataset-independent because it freezes the resolved
  input boundary and model-owned adapters.
- Existing diagrams migrate `Input.params.shape` and `Input.params.dtype` out
  of the node; existing datasets migrate their symbolic dimensions and input
  adapter metadata before those legacy fields are removed.
- There is one resolution path. The implementation must not retain permanent
  precedence or fallback between Input parameters and dataset slots.

## Non-goals

- A general shape-expression or constraint-solving language.
- Inferring dataset parameters from observed Python tensors.
- Keeping `shape` and `dtype` as hidden Input fallbacks.
- Allowing datasets to inject executable inference adapters into wheels.
- Changing target ownership or prediction/objective separation.

## Affected contracts

- [Frontend package type system](../contracts/package-type-system.md)
- [Project-owned datasets and named batches](project-owned-datasets.md)
- [Portable model packages](../contracts/model-package.md)
- [Prediction and objective programs](prediction-objective-programs.md)

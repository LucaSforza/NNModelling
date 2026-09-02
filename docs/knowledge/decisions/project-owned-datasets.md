---
kind: decision
status: accepted
updated: 2026-08-29
---

# Project-owned datasets and named training batches

## Context

NNModelling currently discovers trusted dataset classes from the backend
Python environment. FastAPI imports those classes to derive constructor
parameters, a training request sends a Python import target, and the worker
expects each loader item to unpack as `(inputs, targets)` tensors. Dataset data
is installed or mounted by the operator.

Writable projects need the same ownership model for custom datasets that they
use for custom stereotypes: source, declarative metadata and data files belong
inside the project and travel with the selected training job. The project
dataset's Python is browser-supplied executable code and therefore cannot be
imported by FastAPI merely because it implements the same logical interface as
a built-in dataset.

The anonymous two-tensor batch shape is also unnecessarily narrow. A causal
autoregressive dataset can use shifted input and target sequences, while text
or multimodal models may additionally need named tensors such as an attention
mask. The public contract needs stable names without admitting arbitrary Python
object graphs.

## Project layout and ownership

Every project manifest schema v2 declares its complete custom dataset set:

```ts
type ModelDatasetReference = {
  readonly id: string
  readonly version: string
  readonly path: string
}

type ModelManifestV2 = {
  readonly schemaVersion: 2
  readonly id: string
  readonly version: string
  readonly name: string
  readonly description?: string
  readonly customPackages: readonly ModelPackageReference[]
  readonly customDatasets: readonly ModelDatasetReference[]
}
```

Schema v1 remains readable during the phase-two migration and means
`customDatasets: []`. A successful write upgrades it to v2; there is no second
long-lived interpretation of v1.

A project-owned dataset has this layout:

```text
datasets/<dataset-directory>/
├── manifest.json
├── dataset.json
├── dataset.py
└── data/
```

- `manifest.json` owns exact dataset ID/version and fixed definition/Python
  entrypoints.
- `dataset.json` owns display metadata, configurable parameters, batch slots,
  optional class metadata and declarative inference-adapter metadata.
- `dataset.py` implements the shared dataset builder/runtime contract.
- `data/` contains every project-owned byte used by the implementation.

Paths are relative to the project root, cannot escape it and cannot use
symlinks or external filesystem references. Network access remains disabled in
the worker, so a project dataset cannot download missing data at training time.

## Named batch contract

The version-one normalized worker boundary is a flat map of named tensors:

```python
@dataclass(frozen=True)
class TrainingBatch:
    inputs: Mapping[str, torch.Tensor]
    targets: Mapping[str, torch.Tensor]
```

The dataset definition declares the same names and tensor contracts:

```json
{
  "batch": {
    "inputs": {
      "tokens": { "shape": ["B", "T"], "dtype": "int64" },
      "attention_mask": { "shape": ["B", "T"], "dtype": "bool" }
    },
    "targets": {
      "next_tokens": { "shape": ["B", "T"], "dtype": "int64" }
    }
  }
}
```

Slot names are stable identifiers. Every value is one tensor; arbitrary nested
lists, tuples, dictionaries and user-defined batch objects are not v1. All
used tensors have a compatible leading batch dimension and are moved to the
selected device by the trusted worker runtime, not by dataset code.

One or more top-level `Input` nodes may declare distinct input binding names.
This phase supersedes the earlier exactly-one-top-level-Input invariant. A
dataset selected for training must declare every bound input slot with a
compatible shape and dtype. Extra declared slots are allowed so one dataset can
serve different models, but undeclared graph bindings fail before the epoch
loop.

Objective packages bind exact target slots through versioned sources such as
`batch.targets.next_tokens`. Missing slots and incompatible tensor contracts
fail before training. Empty `targets` are valid only when the compiled
objective requires no target-bound external input.

An autoregressive language dataset therefore needs no protocol special case:

```python
TrainingBatch(
    inputs={"tokens": sequence[:, :-1]},
    targets={"next_tokens": sequence[:, 1:]},
)
```

## Shared dataset package contract

The only supported dataset runtime is the project-owned dataset contract.
Project datasets are untrusted uploaded resources and their source changes
storage and trust, not dataset semantics or the training UI schema.

The Python entrypoint exposes a fixed builder equivalent to:

```python
def build(parameters: Mapping[str, object], context: DatasetContext) -> Dataset:
    ...
```

`DatasetContext` supplies the read-only dataset resource root. The returned
dataset owns `division()` and produces train, validation and test DataLoaders
whose items normalize to `TrainingBatch`. Declarative parameter definitions,
not FastAPI signature inspection, drive the UI and request validation.

The canonical example is the VAE's project-owned
`example.vae-mnist@0.1.0` dataset. There is no backend built-in dataset
registry or Python import target to discover.

## Transport and execution

- The browser validates the project dataset manifest, definition and confined
  resource closure without executing Python.
- The browser uploads one complete dataset archive separately from the model
  package bundle. FastAPI validates bounded declarative metadata, paths, digest
  and ownership but never imports `dataset.py`.
- The backend stores the immutable archive by digest under the authenticated
  connection and returns an opaque dataset reference. Jobs persist the exact
  dataset ID, version, digest and normalized parameters.
- The controller mounts the resolved dataset archive read-only inside the same
  least-privilege worker used for browser-supplied package Python. The worker's
  fixed loader imports the declared dataset entrypoint only inside that
  container.
- Training requests never contain a Python import target, browser path or host
  path. They contain an opaque resolved dataset reference and typed parameters.

## Deliberately simple upload v1

The first project-dataset transport is intentionally for small and medium
datasets:

- one complete authenticated archive upload per digest;
- one backend-advertised maximum byte size enforced before persistence;
- content-addressed deduplication for an identical owned digest;
- no multipart or resumable upload;
- no object-storage integration, background synchronization or partial retry;
- no delta upload when one file changes;
- no promise that a dataset larger than the configured cap is supported.

The UI must state the current backend limit before upload and show transferred
bytes and terminal failure. Large datasets require a later design for chunking,
resume, quotas, garbage collection and object storage; they must not silently
stretch this v1 path.

## Authoring and failure semantics

The project Dataset manager mirrors stereotype authoring. It collects identity,
display metadata, parameter definitions, named input/target slots, class
metadata and optional source files, then creates the four-entry layout above.
The generated Python is readable and demonstrates the builder, context,
DataLoader splits and named `TrainingBatch` contract. A basic `.pt` split
loader may be supplied as an editable starting point; it is not a hidden
format requirement.

Creation is transactional from the application's perspective. Deterministic
validation runs before filesystem mutation. On failure, the previous model
manifest and dataset catalog remain active, and only a directory proven to have
been created by the failed operation may be removed.

Dataset upload and job submission are separate commits. A failed upload creates
no job. A failed job submission does not delete an already valid owned dataset
archive. Invalid code can fail only in the worker and produces a scoped job
diagnostic without executing in FastAPI.

## Non-goals

- Large-dataset, resumable, multipart or object-storage transport in v1.
- External paths, symlinks, network downloads or credentials in project data.
- Arbitrarily nested batch values or non-tensor model/objective inputs.
- Executing project dataset Python in FastAPI or on the host as a fallback.
- Inferring batch bindings from Python signatures, dictionary iteration order,
  package IDs or display names.
- Dataset-specific graph generation or automatic model architecture changes.

## Implementation sequence

Dataset work is phase two of the
[`writable project and authoring plan`](../../plans/active/project-workspaces-and-stereotype-authoring/plan.md).
It cannot start until phase-one workspace/stereotype behavior passes its own
real-interface QA gate.

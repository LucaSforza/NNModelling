# Observable nodes — architecture and contracts

**Status:** Approved for implementation  
**Date:** 2026-07-22  
**Source requirement:** `analysis/requirements/oberver.md`  
**Selected agents:** `frontend-openai`, `backend-openai`, `reviewer-openai`

## 1. Outcome

Add passive, stereotype-driven `Observable` nodes to NNModelling. They receive
signals from the visual graph but never participate in model topology, output,
type propagation, parameters, or weights. Version 1 includes
`ActivationRecorder` and `ActivationStatistics`, execution-mode gating,
stereotype-defined finalization, one W&B table per Observable, local fallback,
unit coverage, and one browser-to-runtime end-to-end path.

The existing `SourceHandle` and `TargetHandle` concepts are sufficient. An
edge is an observation edge when its target node has category `Observable`; no
new edge subclass or persisted edge discriminator is introduced.

## 2. Architectural invariants

1. The browser's `DiagramCore` remains the source of truth for diagrams.
2. Observation edges remain in source diagram JSON but are removed before all
   computational topological traversals.
3. Existing NNTree `root`, `nodes`, and `lossNode` semantics remain unchanged.
4. Observable definitions are emitted only under `interpretability`.
5. Observable runtime objects are not inserted into the model's
   `nn.ModuleDict` and their temporary state is absent from `state_dict` and
   saved model weights.
6. Captured forward values are detached by default. Observables never return a
   replacement value from a hook and cannot alter autograd.
7. Observable diagnostics are attributed to the Observable. They can disable
   that analysis, but cannot block a valid model when the Observable is
   disabled.
8. Existing diagrams without `interpretability` compile and run identically.
9. W&B is an optional publisher. Local result persistence is always available.
10. Internal module points beyond the implicit public `out` point are schema-
    ready but not exposed in the version-1 editor.

## 3. Stereotype contract

Observable stereotypes live in `Stereotypes/Observables/`. Fixed semantics are
not editable instance parameters.

```json
{
  "category": "Observable",
  "pythonClassName": "interpretability.ActivationRecorder",
  "view": {"color": "#7c3aed", "width": 210, "height": 100},
  "observable": {
    "captureKind": "FORWARD_VALUE",
    "supportedModes": ["TRAIN", "EVAL", "PREDICT"],
    "finalizePhase": "POST_RUN",
    "defaultRetentionScope": "RUN",
    "supportedRetentionScopes": ["LAST", "BATCH", "EPOCH", "RUN"],
    "defaultStorageStrategy": "SAMPLED",
    "supportedStorageStrategies": ["FULL", "SAMPLED"],
    "inputs": [
      {"id": "in-0", "label": "activation", "required": true}
    ],
    "resultSchema": {
      "kind": "tensor_reference",
      "fields": ["artifact", "shape", "dtype", "size"]
    }
  },
  "params": {
    "execution_modes": {
      "type": "str",
      "default": "['TRAIN', 'EVAL', 'PREDICT']"
    },
    "retention_scope": {"type": "str", "default": "RUN"},
    "storage_strategy": {"type": "str", "default": "SAMPLED"},
    "max_samples": {"type": "int", "default": "128"},
    "sample_every": {"type": "int", "default": "1"},
    "move_to_cpu": {"type": "bool", "default": "True"},
    "detach": {"type": "bool", "default": "True"},
    "wandb_table_name": {"type": "str", "default": ""}
  },
  "type_signature": {
    "kind": "observable",
    "input": [[{"kind": "wildcard"}]]
  }
}
```

`ActivationStatistics` uses `FORWARD_VALUE`, supports `TRAIN` and `EVAL`,
finalizes at `POST_EPOCH`, defaults to `EPOCH` retention and `STREAMING`
storage, and declares scalar result fields for count, mean, variance, norm and
sparsity. No common reduction enum is added.

The frontend type model must represent Observable signatures explicitly rather
than pretending that an Observable is a module with an empty output tensor.
The `observable.inputs` order is authoritative and must correspond to
`in-0`, `in-1`, and so on. Future stereotypes may add more inputs without
changing TypeScript or Python dispatch code.

The structural `enabled` value is stored directly in node data and defaults to
`true`. `execution_modes`, retention, storage and analysis-specific values are
instance parameters merged through the existing stereotype parameter path.

## 4. Source diagram representation

An Observable is a normal Svelte Flow node with `type: "observable"`:

```json
{
  "id": "obs-1",
  "type": "observable",
  "data": {
    "name": "Hidden activations",
    "stereotype": "ActivationRecorder",
    "isObservable": true,
    "enabled": true,
    "params": {}
  }
}
```

Observation edges remain ordinary edges. Version 1 uses source handle `out`;
the compiler persists it as `sourcePoint`. An Observable has one or more fixed
target handles and no source handle.

## 5. Compiled contract

The NNTree JSON gains an optional, additive section:

```json
{
  "root": "input-id",
  "lossNode": {},
  "nodes": {},
  "interpretability": {
    "enabled": true,
    "observables": {
      "obs-1": {
        "id": "obs-1",
        "name": "Hidden activations",
        "stereotype": "ActivationRecorder",
        "pythonClassName": "interpretability.ActivationRecorder",
        "enabled": true,
        "captureKind": "FORWARD_VALUE",
        "supportedModes": ["TRAIN", "EVAL", "PREDICT"],
        "executionModes": ["TRAIN", "EVAL"],
        "finalizePhase": "POST_RUN",
        "retentionScope": "RUN",
        "storageStrategy": "SAMPLED",
        "inputs": [
          {
            "targetHandle": "in-0",
            "sourceNodeId": "linear-1",
            "sourcePoint": "out"
          }
        ],
        "params": {},
        "resultSchema": {}
      }
    }
  }
}
```

Rules:

- `nodes` and every computational `children` list contain no Observable IDs.
- `inputs` are sorted by numeric `targetHandle`, never edge traversal order.
- The implicit source point is `out`. A non-`out` source is rejected unless it
  exists in the source stereotype's future `observablePoints` declaration.
- Raw source params remain in source-diagram format; `convert.py` parses them
  with the established `parse_params` behavior before writing Hydra YAML.
- Missing `interpretability` means globally disabled with zero runtime setup.

Hydra receives a separate `interpretability/observables.yaml` group and an
optional `interpretability` default in `base.yaml`. It must never be merged
into `cfg.net.nodes`.

## 6. Compiler and type-system behavior

The compiler first partitions nodes and edges:

```text
computational nodes = nodes whose stereotype is not Observable
observation nodes   = nodes whose stereotype is Observable
computational edges = edges whose target is not Observable
observation edges   = edges whose target is Observable
```

All existing NNTree traversal helpers operate on the computational partition.
This filtering must also apply inside subflows. Observable definitions are
compiled independently from observation edges.

Because current NNTree sequential compaction can hide individual visual node
IDs inside `layers`, each compiled `ModuleData` must preserve its visual
`moduleId`. This is additive metadata and allows the runtime to associate the
public output of every visual node with its Observable sources without
changing computational topology.

Type inference uses the same partition for model ordering. It then validates
each Observable separately:

- exact required-handle occupancy;
- ordered input count and labels;
- source point existence;
- each incoming tensor against the corresponding Observable input pattern;
- selected execution modes as a subset of supported modes;
- retention and storage values against supported values.

Observable annotations contain `inputTypes` and no `outputType`. Enabled,
invalid Observables produce diagnostics on their own node and are excluded
from runtime compilation. Disabled Observable diagnostics are non-blocking.
No Observable can create `blockedBy` diagnostics on computational nodes.

## 7. Runtime architecture

Add a dedicated `converted/src/interpretability/` package:

```text
interpretability/
├── __init__.py
├── base.py          protocol, context, result and lifecycle
├── manager.py       config validation, source binding, mode/finalize routing
├── publishers.py    local publisher and optional W&B table publisher
├── recorder.py      ActivationRecorder
└── statistics.py    ActivationStatistics
```

### 7.1 Lifecycle

`ObservableManager` is a plain runtime collaborator owned by `Net`, not a
trainable module. It:

1. instantiates enabled analyses from `cfg.interpretability`;
2. resolves visual source IDs to runtime modules;
3. attaches forward hooks that return `None` and never replace outputs;
4. manually captures passthrough Input/Fork outputs where no module exists;
5. gates capture by global enablement and current `ExecutionMode`;
6. routes `POST_BATCH`, `POST_STEP`, `POST_EPOCH`, and `POST_RUN` lifecycle
   events from Lightning and inference entry points;
7. publishes each finalized result to its own stable table/key;
8. removes hooks and clears temporary state before whole-model serialization.

`IMMEDIATE` is implemented inside capture. `POST_BATCH` is emitted after each
training/validation/test step. `POST_STEP` is emitted after optimizer step.
`POST_EPOCH` is emitted from phase-specific epoch-end hooks. `POST_RUN` is
emitted from fit/test/predict completion and explicit inference finalization.
Duplicate finalization across Lightning phases must be prevented by scoped
state and idempotent flushes.

### 7.2 Source binding

Sequential compaction must not make visual nodes unobservable. The compiler
adds `moduleId` to each layer. `Net` builds a non-owning source registry while
instantiating layers:

- compacted sequential layer `moduleId` → the corresponding child module;
- standalone module/join/subflow node ID → its module;
- nested subflow internal IDs → recursively exposed internal modules;
- Input/Fork IDs → manual passthrough capture in execution code.

Version 1 supports the implicit public `out` point. Additional internal
`observablePoints` are validated by schema but are a later editor/runtime
feature unless an existing module exposes an explicit resolver.

### 7.3 State and storage

`ActivationRecorder` samples detached values and writes large tensors to local
files. Table rows contain references and metadata, not raw large tensors.
`ActivationStatistics` updates streaming count, mean, variance, norm and
sparsity without retaining all tensors.

Common row fields are:

```text
observable_id, observable_name, stereotype, execution_mode,
epoch, global_step, batch_index, sources, sample_count, timestamp
```

Each Observable owns one table object and one stable publication key derived
from ID or configured table name. W&B publication failures become warnings and
must not fail model execution. The local publisher writes metadata plus tensor
artifacts under a configurable run directory and is used whenever W&B is
absent, disabled, or fails.

Temporary buffers and hook handles are not modules, parameters, or buffers.
`state_dict()` therefore remains unchanged. Before the existing
`torch.save(model, ...)`, `main.py` finalizes, removes hooks and clears
temporary tensors so whole-model pickle output contains no capture state.

## 8. Visual design

Add `ObservableNode.svelte` and a dedicated stylesheet. The component uses:

- violet dotted border and a monitor/eye label, so color is not the only cue;
- fixed, stereotype-defined target handles along the top;
- semantic labels for ordered handles;
- no source handle;
- reduced opacity plus a textual paused badge when disabled;
- existing diagnostic badges for input errors;
- accessible region label and `aria-disabled` state.

The sidebar exposes an Observable creation/editing path, a real boolean
`enabled` control, execution mode selection, and generic stereotype params.
The component must preserve existing selection, undo/redo, import/export and
MCP mutation behavior.

## 9. Validation and compatibility

Version-1 validation includes all ten checks in the source requirement. Since
the shipped stereotypes are forward-only, backward-context validation is
implemented for schema completeness and exercised with a synthetic stereotype
test, but `GradientStatistics` itself is not part of the acceptance scope.

Existing fixtures must produce byte-equivalent computational topology aside
from optional additive metadata (`moduleId` and absent/empty
`interpretability`). Existing Python configs without the new Hydra group must
run with a no-op manager.

## 10. Deferred scope

- `GradientStatistics`, CKA and attention visualization implementations;
- visible module-internal points such as Q/K/V and attention patterns;
- cross-model observation;
- activation mutation, patching, ablation or causal intervention;
- packaging captured data into exported model wheels.

The contracts above reserve `CaptureKind`, ordered multiple inputs,
`sourcePoint`, `resultSchema`, and stereotype-declared observable points so
these additions do not require changing the base Observable semantics.

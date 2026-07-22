Observables and interpretability
================================

Observable nodes are passive, stereotype-driven instruments for inspecting a
model while it trains, evaluates, or predicts. They are useful for answering
questions such as “what activation did this layer produce?” or “how sparse are
these representations?” without turning inspection into another model
operation.

The version-1 implementation provides ``ActivationRecorder`` and
``ActivationStatistics``. The contracts also leave room for gradient and
multi-input analyses, but those analyses are not shipped in v1.

Editor workflow
---------------

1. Create a normal computational diagram and give it a valid model path from
   ``Input`` to its modules, joins, subflows, and loss.
2. Add an ``ActivationRecorder`` or ``ActivationStatistics`` node from the
   Observable category in the sidebar.
3. Drag from a computational node's public ``out`` source handle to the
   Observable's fixed target handle. The same source may continue to feed the
   model and any number of Observables: this is the DSL's ordinary implicit
   fork.
4. Select the Observable to choose its enabled state, execution modes, and
   stereotype parameters. An Observable has no source/output handle, so it
   cannot be connected onward.
5. Convert the diagram as usual. The model graph and observation definitions
   are emitted together in NNTree, but in separate sections.

Two overlaid graphs
-------------------

The source diagram contains two related graphs:

* The **computational graph** contains Input, modules, joins, subflows and
  loss nodes. Its edges define topological order, forward execution, type
  inference, and the generated ``net`` configuration.
* The **observation graph** contains Observable nodes and edges whose target is
  an Observable. It receives values from the computational graph but has no
  path back into it.

The compiler partitions nodes and edges before traversal. Observation edges
remain in the editable JSON, but are excluded from computational topological
sorts, cycle detection, NNTree ``nodes`` and computational ``children`` lists.
The compiled definitions appear under ``interpretability.observables``. A
compacted sequential layer retains its visual ``moduleId`` so the runtime can
bind a public output to the correct Observable source. Inputs are ordered by
their numeric target handle (``in-0``, ``in-1``, ...), never by edge arrival.

The public ``out`` point is the only source point exposed by the v1 editor and
runtime. Module-internal points, such as attention Q/K/V, are schema-ready but
not yet visible or bindable in the v1 workflow.

Observable lifecycle contract
-----------------------------

An Observable stereotype fixes the analysis semantics. Instance parameters
may select permitted options, but cannot change the signal kind, required
inputs, implementation, supported modes, or result meaning.

``ExecutionMode``
    ``TRAIN`` captures during training, ``EVAL`` during validation/test, and
    ``PREDICT`` during prediction. An instance's modes must be a subset of the
    stereotype's supported modes.

``CaptureKind``
    ``FORWARD_VALUE`` is supported by the shipped stereotypes. The contract
    reserves ``BACKWARD_GRADIENT`` for a future gradient analysis.

``FinalizePhase``
    An analysis can finalize ``IMMEDIATE``, ``POST_BATCH``, ``POST_STEP``,
    ``POST_EPOCH`` or ``POST_RUN``. For example, recorder output is finalized
    after a run, while statistics are finalized after an epoch.

``RetentionScope``
    ``LAST`` keeps the latest observation, ``BATCH`` scopes aggregation to a
    batch, ``EPOCH`` to an epoch, and ``RUN`` to the complete execution.

``StorageStrategy``
    ``FULL`` retains observations, ``SAMPLED`` retains a selected subset, and
    ``STREAMING`` updates aggregates without retaining every tensor. The
    analysis implementation, rather than a universal reduction enum, defines
    operations such as mean, variance, norm, and sparsity.

The runtime gates capture by global enablement, ``enabled``, the current mode,
and the selected instance modes. It routes lifecycle events once per scope and
clears temporary buffers at the retention boundary and before model
serialization.

The two initial analyses
------------------------

``ActivationRecorder``
    Captures detached forward values. It supports all three execution modes,
    defaults to ``RUN`` retention and ``SAMPLED`` storage, and writes large
    tensors as local artifact files. Table rows contain references and tensor
    metadata rather than duplicating large tensors in a table.

``ActivationStatistics``
    Consumes forward values in ``TRAIN`` and ``EVAL`` and finalizes at
    ``POST_EPOCH``. It defaults to ``EPOCH`` retention and ``STREAMING``
    storage, producing count, mean, variance, norm, and sparsity fields.

Compiled configuration and Hydra
---------------------------------

An NNTree with observations has an additive section similar to:

.. code-block:: json

   {
     "nodes": {"...": "computational definitions only"},
     "interpretability": {
       "enabled": true,
       "observables": {
         "obs-1": {
           "id": "obs-1",
           "stereotype": "ActivationRecorder",
           "pythonClassName": "interpretability.ActivationRecorder",
           "executionModes": ["EVAL"],
           "finalizePhase": "POST_RUN",
           "retentionScope": "RUN",
           "storageStrategy": "SAMPLED",
           "inputs": [{
             "targetHandle": "in-0",
             "sourceNodeId": "linear-1",
             "sourcePoint": "out"
           }]
         }
       }
     }
   }

``convert.py`` writes this section to a separate Hydra group,
``interpretability/observables.yaml``. ``base.yaml`` includes the group, but
it is never merged into ``cfg.net.nodes``. A missing section is explicitly
disabled and requires no runtime setup. Existing diagrams and old Python
configs therefore retain their model topology and run with a no-op manager.

Runtime guarantees
------------------

``ObservableManager`` is a collaborator owned by ``Net``; it is not a
trainable ``nn.Module``. It resolves visual IDs to modules, attaches passive
forward hooks, captures passthrough Input/Fork values where necessary, routes
Lightning and inference lifecycle events, and removes hooks during cleanup.
Hooks return ``None`` and never replace a module output. Captured values are
detached by default. Observable state, hooks, logger handles, and temporary
buffers are absent from ``state_dict`` and cleared before whole-model pickle
serialization. Enabling or disabling an Observable therefore cannot change
the model output, gradients, parameters, or weights.

Errors are contained. A malformed or incompatible enabled Observable receives a
diagnostic and is skipped from runtime analysis; a disabled invalid Observable
does not invalidate an otherwise valid model. Observable annotations expose
input types but never an output type and never create ``blockedBy`` diagnostics
on computational nodes.

Publishing and local results
----------------------------

Each Observable owns one stable publication key and one W&B Table. Common rows
include the Observable identity, stereotype, execution mode, epoch, global
step, batch index, ordered source metadata, sample count, and timestamp. Large
tensors are represented by artifact references with shape, dtype, and size.

W&B is optional and best effort: a missing, disabled, or failed W&B publisher
does not fail the model. The local publisher always writes JSON metadata and
tensor artifacts beneath a unique ``<root>/<run-id>/`` directory. The root can
be configured with ``NNM_INTERPRETABILITY_ROOT`` or the runtime configuration.
Inference rebinds a loaded model to a fresh run directory so prediction rows
cannot be appended to the training run. ``--interpretability-root`` and
``--interpretability-run-id`` on ``infer.py`` provide explicit control.

Inference example
-----------------

Use the current Hydra argument names when running a generated configuration:

.. code-block:: bash

   cd converted
   uv run python src/main.py \
       --config-path ./configs --config-name base

   uv run python src/infer.py \
       --config-path ./configs --config-name base \
       --weights ./weights.pt \
       --output predictions.json \
       --interpretability-root ./observable-results

``--image-dir`` may be added for image strips and a montage. If prediction
collection is requested, inference opens a fresh ``PREDICT`` scope and
finalizes its Observables independently of the preceding test scope.

Remote training containment
----------------------------

Remote jobs receive the compiled NNTree and generated configuration as job
artifacts. The separate interpretability Hydra group and local result root
remain inside that job's artifact directory; one job cannot append to another
job's result scope. The backend's existing connection ownership rules continue
to govern who can inspect logs, artifacts, or download results. W&B remains an
optional external publisher, while local files provide a contained fallback
when the remote worker has no W&B access.

Validation and type behavior
----------------------------

The editor checks that the stereotype is in the ``Observable`` category, every
required fixed target handle has exactly one edge, handles are complete and
ordered, the public source point exists, selected modes and storage values are
supported, and an Observable cannot feed a computational node. Gradient
requirements are checked for backward-capable contexts even though no
``GradientStatistics`` stereotype ships in v1. Observation edges are excluded
from computational cycle detection.

An input mismatch belongs to the Observable and disables only that analysis.
The source tensor type is validated against the Observable's
``type_signature.input`` pattern; no type is propagated out of the node.

Version-1 limitations
---------------------

The initial release deliberately does not implement ``GradientStatistics``,
internal QKV or other module points, CKA comparison, attention visualization,
cross-model analysis, activation caching, mutation, patching, ablation, or
causal intervention. Public ``out`` observation is the stable v1 contract.
Those features can add new stereotypes and source-point resolvers without
changing the passive graph boundary.

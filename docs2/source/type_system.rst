Tensor type system
==================

NNModelling infers tensor types in the frontend while a package graph is being
edited. The inference rules belong to each package's isolated ``inference.lua``
program and are executed by the browser's package type-system runtime. The
frontend does not use the retired ``TypeEngine`` or JSON ``type_signature``
format, and it never invokes Python or PyTorch to infer types.

Tensor representation
---------------------

A successful inference result contains a shape and one canonical dtype:

.. code-block:: typescript

   type Dimension = string | number;

   type TensorType = {
     shape: readonly Dimension[];
     dtype: DType;
   };

Dimensions may be known numbers or named symbolic dimensions. Symbols are
nominal: the same name denotes the same symbolic dimension, but the frontend
does not run a general equation solver, symbolic broadcasting or constraint
unification. Package Lua rules decide how their input and output tensor values
relate. Dtypes are explicit; there is no implicit promotion or cast. Use the
``core.cast`` package when a graph needs an explicit dtype conversion.

Dataset-backed inputs
---------------------

A top-level model may have one or more ``Input`` nodes with distinct named
bindings. An Input stores its binding in ``params.binding``; it does not store
its own shape or dtype. When a dataset is selected, the matching named slot in
``dataset.batch.inputs`` supplies that Input's tensor contract.

For example, an Input bound to ``image`` resolves from the selected dataset's
``image`` input slot. If there is no selected dataset, the binding is missing,
or a required dataset dimension parameter is unresolved, that region remains
unresolved. It is not assigned a fabricated or ``unknown`` tensor. Dataset
dimensions are named by the dataset contract and resolve from its declared
integer parameters; ``B`` represents the configured batch size. The exported
wheel freezes the resolved input shape and dtype while leaving the leading
batch dimension dynamic.

An ``Input`` used as the declared entry boundary of a nested subflow receives
its type from the enclosing graph. It does not resolve a dataset slot directly.

Package-owned inference
------------------------

The active package definition supplies its kind and parameter schema, and its
Lua program supplies the inference behavior. The graph scheduler invokes that
rule with the node's parameters and the type context for its package kind:

* ``input`` resolves the named dataset input, or receives a subflow boundary;
* ``layer``, ``loss`` and ``output`` consume one graph tensor;
* ``join`` combines multiple graph tensors in ``targetHandle`` order
  (``in-0``, ``in-1``, ...);
* ``subflow`` recursively infers its child graph from the enclosing tensor.

Changing a package's inference behavior therefore means changing its
package-owned Lua rule, not adding a package-ID branch to the frontend. Package
activation and Lua execution faults are reported separately from expected
semantic incompatibilities.

Training objectives
-------------------

Loss packages participate in graph inference like other packages, but training
targets are not ordinary graph edges. A loss package declares any external
objective inputs in its package definition; the worker resolves those named
bindings from the selected dataset's ``batch.targets`` and passes them to the
objective program. The explicit ``output`` package marks the prediction result
used by the inference program, which does not require targets.

Inference states
----------------

The editor keeps these outcomes distinct:

* **Unresolved** — a dataset, required parameter or upstream tensor is not yet
  available. This is normal while editing or before selecting a dataset.
* **Success** — the package returned a valid tensor shape and dtype.
* **Error** — the package reported an expected semantic incompatibility.
* **Fault** — package activation or Lua execution failed.

Unresolved nodes do not receive placeholder tensors. Independent graph regions
can still be analyzed while another region awaits its inputs. Hidden children
of collapsed subflows remain part of graph inference.

See :doc:`user_guide` for how dataset selection and Input bindings fit into
graph editing.

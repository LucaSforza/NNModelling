Troubleshooting
===============

Start with the visible save, tensor or training diagnostic. These describe
different stages; a valid graph does not prove that its dataset files or worker
runtime are ready.

Project cannot open or save
---------------------------

* **Directory access unavailable:** use a host that provides writable directory
  selection. The web editor requires File System Access; the Linux desktop
  host provides native directory access.
* **Permission denied:** grant write access to the project directory and reopen
  it. A failed save must not be treated as a saved edit.
* **Missing project resources:** open the directory containing ``model.json``
  and retain every package and dataset directory declared by its manifest.
* **Source changes do not appear:** reopen the project after editing Lua,
  Python or metadata outside the editor. External files are not watched.

Tensor remains unresolved or reports an error
---------------------------------------------

1. Select a project dataset and fill its required dimension parameters.
2. Match every Input's ``binding`` to a declared ``batch.inputs`` slot.
3. Check required layer parameters and upstream connections.
4. For a join, check operand order as well as shape and dtype.

An **unresolved** result means required information is missing. An **error**
means the package rejected a tensor combination. A **fault** means package
activation or Lua execution failed; inspect the package diagnostic and its
source. See :doc:`type_system`.

For image tensors, use an explicit Flatten when the next Linear layer expects
flattened features. Changing a displayed dimension does not reshape runtime
data. Use Cast when an operation needs a different dtype; implicit dtype
promotion is not provided.

Backend will not connect
------------------------

Check the backend URL, then have the operator verify its health and allowed
origins. ``localhost`` and ``127.0.0.1`` are different origins, as are different
ports. The desktop origin is ``app://nnmodelling``.

Pairing requests expire and connections can be revoked. Request a new
connection or renewal and have the operator approve it when needed. A separately configured MCP backend identity does not automatically
share the selected editor's jobs or dataset permissions.

Dataset upload or training fails
--------------------------------

* **Upload rejected:** inspect compressed size, expanded size, member count,
  manifest validity and resource paths. A failed upload does not create a job.
* **Dataset reference rejected after pairing changes:** republish the dataset
  through the current connection.
* **Job remains queued:** the operator should check scheduler capacity,
  controller health, requested resources and worker image configuration.
* **Worker fails:** read the job's logs and diagnostics. Confirm that the
  dataset files exist, its loader returns the declared named tensors, and loss
  bindings match its target slots.
* **Online W&B unavailable:** ask the operator to configure its credentials,
  network and proxy. The editor cannot supply an API key or override that policy.

The terminal job state is authoritative. Ongoing upload messages during W&B
finalization do not themselves prove success or failure.

Downloaded model cannot be used
-------------------------------

Install the wheel into the Python environment running your script and import
the exact ``nnm_<suffix>`` name selected at download. Supply already prepared
tensors to ``predict_tensor`` with the exported shapes and dtypes. Multiple
inputs require a mapping keyed by input binding name.

Use only adapters declared by that model. An external weights file must be a
compatible safetensors checkpoint for the same exported architecture; missing
or mismatched tensors are rejected. See :doc:`python_api` for examples.

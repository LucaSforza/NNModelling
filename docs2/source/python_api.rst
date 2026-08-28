Python API Reference
====================

The Python side is a package runtime and authenticated job backend.

Important modules
-----------------

``package_runtime.compiler``
   Compiles a validated package graph into shared modules plus prediction and
   objective program views.

``package_worker``
   Runs inside the configured Podman or Docker worker container. It receives a
   typed request and dataset batches, then writes training artifacts.

``backend.app``
   FastAPI endpoints for bundle upload, typed job submission, status, logs,
   events, cancellation and artifact download.

``backend.manager``
   Valkey-backed scheduling and container lifecycle coordination.

``model_package.exporter``
   Builds the portable prediction wheel with package graph, resources, input
   adapter metadata and ``safetensors`` weights.

The old graph-conversion and host-training interfaces are not part of the
public Python API.

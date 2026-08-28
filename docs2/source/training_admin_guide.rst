Training administration
=======================

The backend exposes authenticated package-bundle upload and job lifecycle
endpoints. Valkey is the control plane for ownership, priority/FIFO scheduling,
heartbeats, cancellation, recovery and SSE log cursors.

Workers
-------

Configure a Podman or Docker runtime image and run each package job in a
short-lived container. The controller must apply least-privilege credentials,
read-only package inputs, bounded CPU/memory/GPU resources, isolated artifact
mounts, a timeout and the configured network policy. FastAPI must never execute
uploaded package Python.

Artifacts
---------

Store each job under its owned artifact directory. A successful job includes
training summary, logs, ``safetensors`` weights and a portable prediction wheel.
The wheel must install and import in a clean environment without this checkout.

Operational checks
------------------

Reject non-package network formats, unknown request fields, invalid bundle
references, ownership violations and malformed typed training values. Verify
that failed submissions do not leave orphan job records and that queued jobs
cannot remain indefinitely when no compatible worker runtime is configured.

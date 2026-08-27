---
id: T04
kind: task
status: superseded
plan: ../plan.md
superseded_by: ../../package-backend-standard/tasks/P02-bundle-storage.md
role: backend
depends_on: [T01, T03]
parallel_with: [T02]
write_scope:
  - converted/src/backend/models.py
  - converted/src/backend/app.py
  - converted/src/backend/manager.py
  - converted/src/backend/package_store.py
  - converted/src/tests/test_package_backend.py
---

# Add authenticated package-bundle jobs

## Objective

Accept, validate, persist and schedule a package-format job while preserving
the existing NNTree API, pairing ownership, Valkey lifecycle, SSE events,
cancellation and artifact integrity behavior.

## Context required

- [Initiative plan](../plan.md)
- Accepted T01 transport/trust contract.
- `converted/src/backend/models.py`
- `converted/src/backend/app.py`
- `converted/src/backend/manager.py`
- `converted/src/backend/store.py`
- `converted/src/backend/auth.py`
- `converted/src/tests/test_remote_backend.py`

## Invariants

- `nntree` remains a separate, backward-compatible network variant.
- Uploads and jobs are scoped to the authenticated `connection_id`; no path
  supplied by a client is used as an artifact or import path.
- Validation happens before queueing: size, archive shape, digest, manifest,
  dependency closure, runtime version, package allowlist and graph topology.
- Public status and download endpoints preserve ownership and do not expose
  secrets or backend-private filesystem paths as required client inputs.

## Allowed files

- The backend models, app, manager and new package store listed in `write_scope`.
- Focused package backend tests.

## Out of scope

- Container engine argv and image construction (T05).
- Frontend UI/export implementation (T02/T06).
- Changing the existing pairing protocol or Valkey schema beyond the minimum
  versioned records needed for package bundles.

## Work

1. Add the discriminated package network/job models and bounded upload endpoint.
2. Store immutable, content-addressed bundle bytes under the artifact policy;
   record owner, digest and manifest metadata without persisting source in
   Valkey unnecessarily.
3. Dispatch package jobs to the package worker/compiler while retaining the
   current NNTree config path.
4. Reuse job status/events/log/cancel/download behavior and add package-specific
   error codes without leaking paths or source contents.
5. Add tests for auth ownership, duplicate/path-traversal archives, digest and
   dependency failures, queue recovery, cancellation and legacy parity.

## Acceptance criteria

- [ ] A valid bundle can be uploaded and referenced by exactly one owned job.
- [ ] Invalid or unauthorized bundles never enter the queue.
- [ ] Existing `nntree` tests pass unchanged or with narrowly justified schema
      fixtures.
- [ ] Package job status, SSE, logs, cancellation and terminal errors are
      observable through the existing authenticated lifecycle.

## Validation

```bash
cd converted && uv run pytest src/tests/test_package_backend.py -q
cd converted && uv run pytest src/tests/test_remote_backend.py src/tests/test_backend_auth.py -q
```

## Required handoff

Return API examples, persisted-record fields, error codes, size/timeout limits
and the executor input contract required by T05.

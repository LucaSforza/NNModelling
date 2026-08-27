---
id: P02
kind: task
status: ready
plan: ../plan.md
role: backend
depends_on: [P01]
write_scope:
  - converted/src/backend/app.py
  - converted/src/backend/package_store.py
  - converted/src/backend/models.py
  - converted/src/tests/
---

# Implement bounded immutable bundle storage

Define one canonical archive schema for the package graph and dependency
closure. Stream the upload into a bounded temporary file, reject traversal,
duplicates, undeclared resources, invalid digests, oversized files/archives,
excessive graph depth/nodes and unsupported runtime versions before creating a
job directory. Store content by digest with put-if-absent semantics and keep
`connection_id` ownership in a separate ACL record.

All failures must be typed 403/404/409/422 responses. No client-supplied path,
import string or engine option may reach persistence or execution.

Acceptance: invalid uploads leave no files/jobs; two owners cannot overwrite or
read each other's digest; unknown references do not produce HTTP 500.

Validation:

```bash
cd converted && uv run pytest src/tests/test_package_backend.py src/tests/test_package_store.py -q
```

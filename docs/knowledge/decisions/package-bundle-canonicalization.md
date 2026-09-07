---
kind: decision
status: accepted
updated: 2026-09-07
---

# Package-bundle canonicalization and integrity errors

## Context

The browser computes a SHA-256 digest before uploading a `package-bundle/v1`.
The backend recomputes that digest before accepting and storing the bundle.
Independent JSON encoders previously serialized values such as `0.00001`
differently (`0.00001` in JavaScript and `1e-05` in Python), causing valid
bundles to be rejected as digest mismatches.

## Decision

- Bundle digests use RFC 8785 (JSON Canonicalization Scheme, JCS) semantics:
  recursively sorted object keys, compact UTF-8 JSON, ECMAScript-compatible
  number rendering, normalized negative zero, and literal Unicode characters.
- The browser implementation is `canonicalJson` in
  `front-end/src/training/package-bundle.ts`; the backend implementation is
  `package_runtime.jcs.canonicalize`, used by
  `package_runtime.loader.bundle_digest`.
- The `digest` member itself is excluded from the canonical payload before
  hashing, so it cannot influence its own digest.
- Digest behavior is covered by cross-runtime vectors for decimal/exponent
  forms, negative zero, large and tiny values, and Unicode. Any change to the
  canonicalization algorithm must update both runtimes and those vectors.

## Error contract

The backend returns HTTP 422 with code `package_bundle_digest_mismatch` when a
declared digest does not match the canonical payload. The frontend maps that
machine-readable error to an actionable message and makes clear that no
training job was created. Raw backend exception text is not shown as the user
message.

## Non-goals

- Digest verification is not disabled or replaced with trust in a client
  declaration.
- Dataset archive digests and wheel digests remain byte-level SHA-256 checks;
  this decision concerns JSON package bundles only.

## References

- [package bundle builder](../../../front-end/src/training/package-bundle.ts)
- [backend canonical digest](../../../converted/src/package_runtime/loader.py)
- [JCS implementation](../../../converted/src/package_runtime/jcs.py)
- [cross-runtime tests](../../../front-end/src/__tests__/packageBundle.test.ts)

import { describe, expect, test } from "vitest"

import {
  DatasetContractError,
  parseDatasetDefinition,
  parseDatasetReference,
  parseModelManifest,
  serializeDatasetDefinition,
} from "../project-workspace/dataset-contract"
import { validateDatasetSelection } from "../training/dataset-contract"

const DEFINITION = {
  schemaVersion: 1,
  id: "demo.tokens",
  version: "1.0.0",
  name: "Tokens",
  parameters: [{ name: "max_length", type: "integer", required: false, default: 128 }],
  batch: {
    inputs: { tokens: { shape: ["B", "T"], dtype: "int64" } },
    targets: { next_tokens: { shape: ["B", "T"], dtype: "int64" } },
  },
}

describe("dataset and manifest contracts", () => {
  test("round-trips a definition with stable named slots", () => {
    const parsed = parseDatasetDefinition(DEFINITION)
    expect(JSON.parse(serializeDatasetDefinition(parsed))).toEqual(parsed)
    expect(Object.keys(parsed.batch.inputs)).toEqual(["tokens"])
  })

  test("accepts the exhaustive v2 manifest without losing packages", () => {
    const result = parseModelManifest({
      schemaVersion: 2,
      id: "demo.model",
      version: "1.0.0",
      name: "Demo",
      customPackages: [{ id: "demo.layer", version: "1.0.0", path: "packages/layer" }],
      customDatasets: [],
    })
    expect(result.manifest).toMatchObject({ schemaVersion: 2, customDatasets: [], customPackages: [{ id: "demo.layer" }] })
    expect(() => parseModelManifest({ ...result.manifest, schemaVersion: 1 })).toThrow(/unknown-version/)
  })

  test.each([
    [{ ...DEFINITION, extra: true }, "unknown-field"],
    [{ ...DEFINITION, batch: { inputs: { x: { shape: ["B"], dtype: "complex128" } }, targets: {} } }, "unsupported-dtype"],
    [{ ...DEFINITION, batch: { inputs: { x: { shape: ["B"], dtype: "float32" } }, targets: { x: { shape: ["B"], dtype: "float32" } } } }, "duplicate-entry"],
    [{ ...DEFINITION, parameters: [{ name: "bad", type: "integer", required: true, default: 1 }] }, "invalid-parameter"],
  ])("rejects malformed definitions before persistence", (value, code) => {
    expect(() => parseDatasetDefinition(value)).toThrowError(DatasetContractError)
    try { parseDatasetDefinition(value) } catch (error) { expect((error as DatasetContractError).code).toBe(code) }
  })

  test("accepts only opaque project references", () => {
    expect(parseDatasetReference({ kind: "project", id: "demo.tokens", version: "1.0.0", ref: "dataset_abc", digest: "A".repeat(64) })).toMatchObject({ kind: "project", digest: "a".repeat(64) })
    expect(() => parseDatasetReference({ kind: "project", id: "demo.tokens", version: "1.0.0", ref: "datasets/tokens", digest: "A".repeat(64) })).toThrow(/invalid-reference/)
    expect(() => parseDatasetReference({ kind: "project", id: "demo.tokens", version: "1.0.0", ref: "dataset_abc" })).toThrow(/invalid-reference/)
  })

  test("normalizes an opaque training selection without a Python target", () => {
    expect(validateDatasetSelection({
      reference: { kind: "builtin", id: "builtin.mnist", version: "1.0.0", ref: "builtin_mnist" },
      parameters: { batch_size: 32 },
    })).toMatchObject({ reference: { kind: "builtin" }, parameters: { batch_size: 32 } })
    expect(() => validateDatasetSelection({ target: "dataset.mnist.MNISTDataset", parameters: {} })).toThrow()
  })
})

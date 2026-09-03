import { describe, expect, test } from "vitest"

import {
  DatasetContractError,
  parseDatasetDefinition,
  resolveDatasetContract,
} from "../project-workspace/dataset-contract"
import { migrateDatasetDefinition, migrateLegacyInputNodes } from "../project-workspace/dataset-migration"

const definition = parseDatasetDefinition({
  schemaVersion: 1,
  id: "demo.images",
  version: "1.0.0",
  name: "Images",
  parameters: [
    { name: "B", type: "integer", required: true },
    { name: "C", type: "integer", required: true },
  ],
  batch: {
    inputs: { image: { shape: ["B", "C", 28, 28], dtype: "float32" } },
    targets: { label: { shape: ["B", 10], dtype: "int64" } },
  },
})

describe("dataset-driven Input contract", () => {
  test("resolves all symbols from required positive integer parameters", () => {
    expect(resolveDatasetContract(definition, { B: 4, C: 1 })).toEqual({
      id: "demo.images",
      version: "1.0.0",
      parameters: { B: 4, C: 1 },
      batch: {
        inputs: { image: { shape: [4, 1, 28, 28], dtype: "float32" } },
        targets: { label: { shape: [4, 10], dtype: "int64" } },
      },
    })
  })

  test.each([
    [{ B: 4 }, "missing-parameter-value"],
    [{ B: 0, C: 1 }, "invalid-dimension-value"],
    [{ B: 4, C: 1, extra: 2 }, "unknown-parameter"],
  ])("rejects unresolved or invalid selections (%s)", (selection, code) => {
    try {
      resolveDatasetContract(definition, selection)
      throw new Error("expected selection to be rejected")
    } catch (error) {
      expect(error).toBeInstanceOf(DatasetContractError)
      expect((error as DatasetContractError).code).toBe(code)
    }
  })

  test("rejects a symbolic slot dimension without a required integer declaration", () => {
    const invalid = parseDatasetDefinition({
      schemaVersion: 1,
      id: "demo.invalid",
      version: "1.0.0",
      name: "Invalid",
      parameters: [{ name: "T", type: "number", required: true }],
      batch: { inputs: { tokens: { shape: ["T"], dtype: "int64" } }, targets: {} },
    })
    expect(() => resolveDatasetContract(invalid, { T: 4 })).toThrow(/integer parameter/)
  })

  test("migrates top-level legacy Input parameters but preserves subflow boundaries", () => {
    const topLevel = {
      id: "input",
      type: "custom",
      position: { x: 0, y: 0 },
      data: {
        package: { id: "core.input", version: "0.1.0", name: "Input" },
        params: { shape: ["B", 28], dtype: "float32" },
        inputBinding: "image",
      },
    }
    const internal = { ...topLevel, id: "internal", parentId: "subflow" }
    const migrated = migrateLegacyInputNodes([topLevel, internal])
    expect(migrated[0]?.data).not.toHaveProperty("params")
    expect(migrated[0]?.data).toHaveProperty("inputBinding", "image")
    expect(migrated[1]?.data).toHaveProperty("params")
  })

  test("returns dataset adapter metadata for explicit model-owned migration", () => {
    const result = migrateDatasetDefinition({
      schemaVersion: 1,
      id: "demo.images",
      version: "1.0.0",
      name: "Images",
      parameters: [],
      batch: { inputs: {}, targets: {} },
      inferenceAdapter: { kind: "image", version: 1 },
    })
    expect(result.definition).not.toHaveProperty("inferenceAdapter")
    expect(result.legacyInferenceAdapter).toEqual({ kind: "image", version: 1 })
  })
})

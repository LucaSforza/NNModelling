import { describe, expect, test } from "vitest"
import type { Node } from "@xyflow/svelte"
import { compileGraphBindings } from "../type-system/graph/bindings"
import { parseDatasetDefinition } from "../project-workspace/dataset-contract"
import type { Definition } from "../type-system/packages/types"

const input: Definition = {
  name: "Input", kind: "input", view: { color: "#000000", width: 30, height: 30 }, parameters: {},
}
const loss: Definition = {
  name: "Loss", kind: "loss", objective: { externalInputs: [{ name: "target", source: "batch.targets.next_tokens" }] },
  view: { color: "#000000", width: 30, height: 30 }, parameters: {},
}
const defs = new Map([["core.input@0.1.0", input], ["core.loss@0.1.0", loss]])
const dataset = parseDatasetDefinition({
  schemaVersion: 1, id: "text", version: "1.0.0", name: "Text", parameters: [],
    batch: {
    inputs: { attention_mask: { shape: ["B", "T"], dtype: "bool" }, tokens: { shape: ["B", 8], dtype: "int64" } },
    targets: { next_tokens: { shape: ["B", "T"], dtype: "int64" } },
  },
})

function node(id: string, packageId: string, params: Record<string, unknown> = {}, inputBinding?: string): Node {
  return {
    id, type: "custom", position: { x: 0, y: 0 },
    data: { package: { id: packageId, version: "0.1.0", name: id }, params, ...(inputBinding === undefined ? {} : { inputBinding }) },
  } as Node
}

describe("named graph training bindings", () => {
  test("sorts multiple input slots independently from node order", () => {
    const result = compileGraphBindings([
      node("mask", "core.input", { shape: ["B", "T"], dtype: "bool" }, "attention_mask"),
      node("tokens", "core.input", { shape: ["B", "T"], dtype: "int64" }, "tokens"),
    ], defs, undefined, dataset)
    expect(result.diagnostics).toEqual([])
    expect(result.inputBindings).toEqual([
      { nodeId: "mask", name: "attention_mask" },
      { nodeId: "tokens", name: "tokens" },
    ])
  })

  test("rejects missing and duplicate input names", () => {
    const result = compileGraphBindings([
      node("first", "core.input", {}, "tokens"),
      node("second", "core.input"),
      node("third", "core.input", {}, "tokens"),
    ], defs)
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      "missing-input-binding", "duplicate-input-binding",
    ])
  })

  test("rejects objective bindings that do not exist in the selected dataset", () => {
    const result = compileGraphBindings([node("loss", "core.loss")], defs, undefined, dataset)
    expect(result.diagnostics).toEqual([])
    expect(result.objectiveBindings).toEqual([{
      nodeId: "loss", packageId: "core.loss",
      externalInputs: [{ name: "target", source: "batch.targets.next_tokens" }],
    }])
  })

  test("accepts only flat target sources", () => {
    const invalid = new Map([
      ["core.loss@0.1.0", { ...loss, objective: { externalInputs: [{ name: "target", source: "batch.inputs.tokens" }] } }],
    ])
    const result = compileGraphBindings([node("loss", "core.loss")], invalid)
    expect(result.diagnostics.map(({ code }) => code)).toEqual(["invalid-objective-binding"])
  })

  test("reports slot shape and dtype mismatches before training", () => {
    const result = compileGraphBindings([
      node("tokens", "core.input", { shape: ["B", 7], dtype: "float32" }, "tokens"),
    ], defs, new Map([["tokens", { status: "success", output: { shape: ["B", 7], dtype: "float32" } }]]), dataset)
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      "incompatible-input-dtype", "incompatible-input-shape",
    ])
  })
})

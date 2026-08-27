import { describe, expect, it } from "vitest"
import { buildPackageBundle, canonicalJson } from "../training/package-bundle"
import type { PackageExportInfo } from "../type-system/packages/types"
import type { Edge, Node } from "@xyflow/svelte"
import { bundledCorePackages } from "../type-system/bundled/catalog"
import { parseDefinition } from "../type-system/packages/validation"

const adapterInference = {
  nodes: new Map([
    ["input", { status: "success" as const, output: { shape: ["B", 4], dtype: "float32" as const } }],
    ["layer", { status: "success" as const, output: { shape: ["B", 8], dtype: "float32" as const } }],
  ]),
  order: ["input", "layer"],
  terminals: ["layer"],
  complete: true,
}

const input: PackageExportInfo = {
  manifest: {
    schemaVersion: 1, id: "core.input", version: "0.1.0", dependencies: {},
    entrypoints: { definition: "stereotype.json", inference: { language: "lua", file: "inference.lua" } },
  },
  definition: JSON.stringify({ name: "Input", kind: "input", view: { color: "#ffffff", width: 80, height: 40 }, parameters: {} }),
}
const layer: PackageExportInfo = {
  manifest: {
    schemaVersion: 1, id: "test.layer", version: "1.0.0", dependencies: { "core.input": "0.1.0" },
    entrypoints: {
      definition: "stereotype.json",
      inference: { language: "lua", file: "inference.lua" },
      pytorch: { language: "python", file: "pytorch.py" },
    },
  },
  definition: JSON.stringify({
    name: "Layer", kind: "layer",
    wheelAdapters: [{ name: "decode", entrypoint: "module.forward", input: { type: "tensor", shape: ["B", 4], dtype: "float32" }, output: { type: "tensor", shape: ["B", 8], dtype: "float32" }, targetPolicy: "forbidden", randomness: { mode: "none" } }],
    view: { color: "#000000", width: 80, height: 40 }, parameters: {},
  }),
  pytorch: "from stereotype_runtime.pytorch import BuildContext\r\n",
}

function node(id: string, identity: { id: string; version: string; name: string }, parentId?: string): Node {
  return { id, type: "custom", position: { x: 100, y: 100 }, ...(parentId ? { parentId } : {}), data: { package: identity, params: { width: 4, labels: ["x", "y"] } } }
}

describe("package bundle v1", () => {
  it("validates typed stereotype-declared wheel adapters", () => {
    expect(parseDefinition(JSON.parse(layer.definition)).wheelAdapters).toEqual([{
      name: "decode", entrypoint: "module.forward", input: { type: "tensor", shape: ["B", 4], dtype: "float32" }, output: { type: "tensor", shape: ["B", 8], dtype: "float32" }, targetPolicy: "forbidden", randomness: { mode: "none" },
    }])
    for (const adapter of [
      { name: "Decode", entrypoint: "decode", input: { type: "number" }, output: { type: "number" }, targetPolicy: "forbidden" },
      { name: "decode", entrypoint: "decode", input: { type: "number" }, output: { type: "number" }, targetPolicy: "allowed" },
      { name: "decode", entrypoint: "decode", input: { type: "number" }, output: { type: "number" }, targetPolicy: "forbidden", randomness: { mode: "seeded" } },
    ]) {
      expect(() => parseDefinition({ name: "Adapter", kind: "layer", wheelAdapters: [adapter], view: { color: "#000000", width: 80, height: 40 }, parameters: {} })).toThrow()
    }
  })

  it("parses explicit objective bindings and output roles", () => {
    expect(parseDefinition({
      name: "Cross Entropy", kind: "loss",
      objective: { externalInputs: [{ name: "target", source: "batch.targets" }] },
      view: { color: "#000000", width: 80, height: 40 }, parameters: {},
    }).objective).toEqual({ externalInputs: [{ name: "target", source: "batch.targets" }] })
    expect(parseDefinition({
      name: "Output", kind: "output",
      view: { color: "#000000", width: 80, height: 40 }, parameters: {},
    }).kind).toBe("output")
  })

  it("preserves a declared objective target adaptation", () => {
    expect(parseDefinition({
      name: "MSE", kind: "loss",
      objective: { externalInputs: [{ name: "target", source: "batch.targets", transform: "flatten_batch" }] },
      view: { color: "#b85c5c", width: 180, height: 100 }, parameters: {},
    }).objective).toEqual({
      externalInputs: [{ name: "target", source: "batch.targets", transform: "flatten_batch" }],
    })
  })

  it.each([
    [{ name: "Loss", kind: "loss", objective: { externalInputs: [{ name: "target", source: "batch.targets" }, { name: "target", source: "batch.targets" }] } }],
    [{ name: "Loss", kind: "loss", objective: { externalInputs: [{ name: "target", source: "batch.inputs" }] } }],
    [{ name: "Loss", kind: "loss" }],
    [{ name: "Layer", kind: "layer", objective: { externalInputs: [] } }],
  ])("rejects invalid objective declarations", (partial) => {
    expect(() => parseDefinition({ ...partial, view: { color: "#000000", width: 80, height: 40 }, parameters: {} })).toThrow()
  })

  it("keeps PyTorch modules in the browser resource seam", () => {
    const linear = bundledCorePackages().find((selection) => {
      const manifest = JSON.parse(String((selection.resources as Record<string, string>)["manifest.json"])) as { id: string }
      return manifest.id === "core.linear"
    })
    expect((linear?.resources as Record<string, string>)["pytorch.py"]).toEqual(expect.any(String))
  })

  it("rejects a graph binding that its stereotype did not declare", async () => {
    await expect(buildPackageBundle([
      { ...node("layer", { id: "test.layer", version: "1.0.0", name: "Layer" }), data: { package: { id: "test.layer", version: "1.0.0", name: "Layer" }, params: {}, wheelAdapters: ["sample"] } },
    ], [], new Map([["core.input", input], ["test.layer", layer]]))).rejects.toThrow("selects undeclared wheel adapter 'sample'")
  })

  it("is deterministic and preserves semantic graph ordering and closure", async () => {
    const nodes = [
      { ...node("layer", { id: "test.layer", version: "1.0.0", name: "Layer" }), data: { package: { id: "test.layer", version: "1.0.0", name: "Layer" }, params: { width: 4, labels: ["x", "y"] }, wheelAdapters: ["decode"] } },
      node("input", { id: "core.input", version: "0.1.0", name: "Input" }),
    ]
    const edges: Edge[] = [
      { id: "edge", source: "input", target: "layer", sourceHandle: "out", targetHandle: "in-0" },
    ]
    const exports = new Map([["core.input", input], ["test.layer", layer]])
    const first = await buildPackageBundle(nodes, edges, exports, adapterInference)
    const second = await buildPackageBundle([...nodes].reverse(), [...edges].reverse(), exports, adapterInference)

    expect(canonicalJson(first)).toBe(canonicalJson(second))
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(first.graph.nodes[0]?.id).toBe("input")
    expect(first.graph.edges[0]).toMatchObject({ targetHandle: "in-0", sourceHandle: "out" })
    expect(first.graph.nodes.find((item) => item.id === "layer")?.wheelAdapters).toEqual([{
      name: "decode", input: { type: "tensor", shape: ["B", 4], dtype: "float32" }, output: { type: "tensor", shape: ["B", 8], dtype: "float32" },
    }])
    expect(first.packages.map((item) => item.id)).toEqual(["core.input", "test.layer"])
    expect(Object.keys(first.packages[1]?.files ?? {})).toEqual(["manifest.json", "pytorch.py", "stereotype.json"])
  })

  it("rejects executable packages without a PyTorch entrypoint", async () => {
    const broken = new Map([["test.layer", { ...layer, pytorch: undefined }]])
    await expect(buildPackageBundle(
      [node("layer", { id: "test.layer", version: "1.0.0", name: "Layer" })], [], broken,
    )).rejects.toThrow("has no PyTorch entrypoint")
  })

  it("rejects bindings that the concrete package does not declare", async () => {
    const bound = {
      ...node("layer", { id: "test.layer", version: "1.0.0", name: "Layer" }),
      data: { package: { id: "test.layer", version: "1.0.0", name: "Layer" }, wheelAdapters: ["sample"] },
    }
    await expect(buildPackageBundle([bound], [], new Map([["core.input", input], ["test.layer", layer]]))).rejects.toThrow(
      "graph node 'layer' selects undeclared wheel adapter 'sample'",
    )
  })

  it("rejects a selected tensor adapter when instance inference is unavailable", async () => {
    const bound = { ...node("layer", { id: "test.layer", version: "1.0.0", name: "Layer" }), data: { package: { id: "test.layer", version: "1.0.0", name: "Layer" }, wheelAdapters: ["decode"] } }
    await expect(buildPackageBundle([bound], [], new Map([["core.input", input], ["test.layer", layer]]))).rejects.toThrow(
      "wheel adapter input cannot be inferred",
    )
  })

  it("rejects a selected tensor adapter incompatible with the inferred instance output", async () => {
    const incompatible = { ...adapterInference, nodes: new Map([
      ["input", { status: "success" as const, output: { shape: ["B", 4], dtype: "float32" as const } }],
      ["layer", { status: "success" as const, output: { shape: ["B", 7], dtype: "float32" as const } }],
    ]) }
    const bound = { ...node("input", { id: "core.input", version: "0.1.0", name: "Input" }), data: { package: { id: "core.input", version: "0.1.0", name: "Input" }, wheelAdapters: [] } }
    const layerNode = { ...node("layer", { id: "test.layer", version: "1.0.0", name: "Layer" }), data: { package: { id: "test.layer", version: "1.0.0", name: "Layer" }, wheelAdapters: ["decode"] } }
    await expect(buildPackageBundle([bound, layerNode], [{ id: "edge", source: "input", target: "layer", sourceHandle: "out", targetHandle: "in" }], new Map([["core.input", input], ["test.layer", layer]]), incompatible)).rejects.toThrow(
      "wheel adapter 'decode' output schema is incompatible",
    )
  })
})

import { describe, expect, it } from "vitest"
import { buildPackageBundle, canonicalJson } from "../training/package-bundle"
import type { PackageExportInfo } from "../type-system/packages/types"
import type { Edge, Node } from "@xyflow/svelte"
import { bundledCorePackages } from "../type-system/bundled/catalog"
import { parseDefinition } from "../type-system/packages/validation"
import { EditorTypeSystemRuntime } from "../type-system/editor-runtime"
import { createInstalledPackageRecord } from "../type-system/packages/installed/records"

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

function resourceExport(id: string, version: string, dependencies: Record<string, string>, helper: Uint8Array): PackageExportInfo {
  const manifest = { schemaVersion: 1 as const, id, version, dependencies, entrypoints: { definition: "stereotype.json", inference: { language: "lua" as const, file: "lua/inference.lua" }, pytorch: { language: "python" as const, file: "pytorch.py" } } }
  const definition = { name: id, kind: "layer" as const, view: { color: "#000000", width: 80, height: 40 }, parameters: {} }
  return {
    manifest,
    definition: JSON.stringify(definition),
    resolvedDependencies: Object.fromEntries(Object.keys(dependencies).map((dependency) => [dependency, `${dependency}@0.1.0`])),
    resources: {
      "manifest.json": new TextEncoder().encode(JSON.stringify(manifest)),
      "stereotype.json": new TextEncoder().encode(JSON.stringify(definition)),
      "lua/inference.lua": new TextEncoder().encode("return function() end"),
      "pytorch.py": new TextEncoder().encode("# exact bytes\r\n"),
      "helpers/constants.bin": helper,
    },
  }
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
    expect(parseDefinition({ name: "Sampler", kind: "layer", wheelAdapters: [{ name: "sample", entrypoint: "module.sample", input: { type: "tensor", shape: ["B", 2], dtype: "float32" }, output: { type: "tensor", shape: ["B", 2], dtype: "float32" }, targetPolicy: "forbidden" }], view: { color: "#000000", width: 80, height: 40 }, parameters: {} }).wheelAdapters?.[0].entrypoint).toBe("module.sample")
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

  it("exports an external package's exact resource closure and resolved keys", async () => {
    const helper = new Uint8Array([0, 255, 1, 2])
    const external = resourceExport("vendor.layer", "2.0.0", { "core.input": "0.1.0" }, helper)
    const core = resourceExport("core.input", "0.1.0", {}, new Uint8Array([9]))
    const bundle = await buildPackageBundle([node("external", { id: "vendor.layer", version: "2.0.0", name: "ignored" })], [], new Map([
      ["vendor.layer@2.0.0", external], ["core.input@0.1.0", core],
    ]))
    const packageInfo = bundle.packages.find((candidate) => candidate.id === "vendor.layer")!
    expect(packageInfo.resolvedDependencies).toEqual({ "core.input": "core.input@0.1.0" })
    expect(Object.keys(packageInfo.files)).toEqual([
      "helpers/constants.bin", "lua/inference.lua", "manifest.json", "pytorch.py", "stereotype.json",
    ])
    expect(packageInfo.files["helpers/constants.bin"]?.content).toBe("AP8BAg==")
    expect(packageInfo.files["pytorch.py"]?.content).toBe(btoa("# exact bytes\r\n"))
  })

  it("exports the active model scope, including local Python resources only", async () => {
    const coreInput = await createInstalledPackageRecord({
      source: "bundled",
      manifest: input.manifest,
      definition: parseDefinition(JSON.parse(input.definition)),
      resources: {
        "manifest.json": JSON.stringify(input.manifest),
        "stereotype.json": input.definition,
        "inference.lua": "return function() end",
      },
    })
    const sampling = resourceExport("example.vae.sampling", "0.1.0", {}, new Uint8Array([1]))
    const kl = resourceExport("example.vae.kl-divergence", "0.1.0", {}, new Uint8Array([2]))
    const runtime = await EditorTypeSystemRuntime.create({ bundled: [coreInput] })
    try {
      const modelBundle = (record: PackageExportInfo, path: string): Record<string, string | Uint8Array> => (
        Object.fromEntries(Object.entries(record.resources ?? {}).map(([filePath, content]) => [`${path}/${filePath}`, content]))
      )
      await runtime.switchModelScope({
        schemaVersion: 1,
        id: "example.vae-mnist",
        version: "0.1.0",
        name: "VAE",
        customPackages: [
          { id: "example.vae.sampling", version: "0.1.0", path: "packages/sampling" },
          { id: "example.vae.kl-divergence", version: "0.1.0", path: "packages/kl-divergence" },
        ],
      }, { ...modelBundle(sampling, "packages/sampling"), ...modelBundle(kl, "packages/kl-divergence") }, [
        { id: "core.input", version: "0.1.0" },
        { id: "example.vae.sampling", version: "0.1.0" },
        { id: "example.vae.kl-divergence", version: "0.1.0" },
      ])
      const graphNodes = [
        node("input", { id: "core.input", version: "0.1.0", name: "Input" }),
        node("sampling", { id: "example.vae.sampling", version: "0.1.0", name: "Sampling" }),
        node("kl", { id: "example.vae.kl-divergence", version: "0.1.0", name: "KL" }),
      ]
      const vaeBundle = await buildPackageBundle(graphNodes, [], runtime.packageExports())
      expect(vaeBundle.packages.map(({ id }) => id)).toEqual([
        "core.input", "example.vae.kl-divergence", "example.vae.sampling",
      ])
      expect(vaeBundle.packages.filter(({ id }) => id.startsWith("example.vae.")).every(({ files }) => files["pytorch.py"]?.size > 0)).toBe(true)

      await runtime.switchModelScope({
        schemaVersion: 1,
        id: "example.resnet-mnist",
        version: "0.1.0",
        name: "ResNet",
        customPackages: [],
      }, undefined, [{ id: "core.input", version: "0.1.0" }])
      const resnetBundle = await buildPackageBundle([graphNodes[0]!], [], runtime.packageExports())
      expect(resnetBundle.packages.map(({ id }) => id)).toEqual(["core.input"])
      expect(resnetBundle.packages.some(({ id }) => id.startsWith("example.vae."))).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })

  it("rejects wrong-version, ambiguous, and failed exact package selections", async () => {
    const v1 = resourceExport("vendor.layer", "1.0.0", {}, new Uint8Array())
    const v2 = resourceExport("vendor.layer", "2.0.0", {}, new Uint8Array())
    await expect(buildPackageBundle([node("layer", { id: "vendor.layer", version: "3.0.0", name: "Layer" })], [], new Map([["vendor.layer@1.0.0", v1]]))).rejects.toThrow("vendor.layer@3.0.0")
    await expect(buildPackageBundle([node("layer", { id: "vendor.layer", version: "1.0.0", name: "Layer" })], [], new Map([["a", v1], ["b", v1]]))).rejects.toThrow("ambiguous")
    await expect(buildPackageBundle([node("layer", { id: "vendor.layer", version: "2.0.0", name: "Layer" })], [], new Map([["vendor.layer@2.0.0", { ...v2, state: "failed" }]]))).rejects.toThrow("not active")
  })
})

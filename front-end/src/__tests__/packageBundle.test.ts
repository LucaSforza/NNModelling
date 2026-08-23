import { describe, expect, it } from "vitest"
import { buildPackageBundle, canonicalJson } from "../training/package-bundle"
import type { PackageExportInfo } from "../type-system/packages/types"
import type { Edge, Node } from "@xyflow/svelte"
import { bundledCorePackages } from "../type-system/bundled/catalog"

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
  definition: JSON.stringify({ name: "Layer", kind: "layer", view: { color: "#000000", width: 80, height: 40 }, parameters: {} }),
  pytorch: "from stereotype_runtime.pytorch import BuildContext\r\n",
}

function node(id: string, identity: { id: string; version: string; name: string }, parentId?: string): Node {
  return { id, type: "custom", position: { x: 100, y: 100 }, ...(parentId ? { parentId } : {}), data: { package: identity, params: { width: 4, labels: ["x", "y"] } } }
}

describe("package bundle v1", () => {
  it("keeps PyTorch modules in the browser resource seam", () => {
    const linear = bundledCorePackages().find((selection) => {
      const manifest = JSON.parse(String((selection.resources as Record<string, string>)["manifest.json"])) as { id: string }
      return manifest.id === "core.linear"
    })
    expect((linear?.resources as Record<string, string>)["pytorch.py"]).toEqual(expect.any(String))
  })

  it("is deterministic and preserves semantic graph ordering and closure", async () => {
    const nodes = [node("layer", { id: "test.layer", version: "1.0.0", name: "Layer" }), node("input", { id: "core.input", version: "0.1.0", name: "Input" })]
    const edges: Edge[] = [
      { id: "edge", source: "input", target: "layer", sourceHandle: "out", targetHandle: "in-0" },
    ]
    const exports = new Map([["core.input", input], ["test.layer", layer]])
    const first = await buildPackageBundle(nodes, edges, exports)
    const second = await buildPackageBundle([...nodes].reverse(), [...edges].reverse(), exports)

    expect(canonicalJson(first)).toBe(canonicalJson(second))
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(first.graph.nodes[0]?.id).toBe("input")
    expect(first.graph.edges[0]).toMatchObject({ targetHandle: "in-0", sourceHandle: "out" })
    expect(first.packages.map((item) => item.id)).toEqual(["core.input", "test.layer"])
    expect(Object.keys(first.packages[1]?.files ?? {})).toEqual(["manifest.json", "pytorch.py", "stereotype.json"])
  })

  it("rejects executable packages without a PyTorch entrypoint", async () => {
    const broken = new Map([["test.layer", { ...layer, pytorch: undefined }]])
    await expect(buildPackageBundle(
      [node("layer", { id: "test.layer", version: "1.0.0", name: "Layer" })], [], broken,
    )).rejects.toThrow("has no PyTorch entrypoint")
  })
})

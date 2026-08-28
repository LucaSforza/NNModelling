import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, describe, expect, test } from "vitest"

import { DiagramCore } from "../core/DiagramCore"
import type { Edge, Node } from "../core/types"
import { EditorTypeSystemRuntime } from "../type-system/editor-runtime"
import { scenarioSnapshot, type SemanticModelScenario } from "../type-system/graph/model-scenario"

const modelRoot = resolve(fileURLToPath(new URL("../../tests/differential/models/", import.meta.url)))
let runtime: EditorTypeSystemRuntime | undefined

afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
})

class MemoryDiagram extends DiagramCore {
  public nodes: Node[] = []
  public edges: Edge[] = []
}

describe("package model editor acceptance", () => {
  test.each([
    ["transformer.json", ["B", "T", 512]],
    ["variational-autoencoder.json", ["B", 784]],
    ["resnet.json", ["B", 224, 224, 1000]],
    ["resnet-product.json", ["B", 1000]],
  ] as const)("imports and infers %s", async (file, expectedShape) => {
    runtime = await EditorTypeSystemRuntime.create()
    const scenario = JSON.parse(await readFile(resolve(modelRoot, file), "utf8")) as SemanticModelScenario & { output: string }
    const snapshot = scenarioSnapshot(scenario, runtime.packages())

    const source = new MemoryDiagram()
    source.nodes = snapshot.nodes
    source.edges = snapshot.edges
    const persisted = source.exportToJson()
    const loaded = new MemoryDiagram()
    expect(loaded.importFromJson(persisted)).toBe(true)

    const result = runtime.infer({ nodes: loaded.nodes, edges: loaded.edges })
    expect(result.complete).toBe(true)
    expect(result.terminals).toEqual([scenario.output])
    expect(result.nodes.get(scenario.output)).toEqual({
      status: "success",
      output: { shape: expectedShape, dtype: "float32" },
    })
    expect(loaded.nodes.every(node => {
      const packageIdentity = node.data.package as { id?: unknown; version?: unknown; name?: unknown } | undefined
      return typeof packageIdentity?.id === "string" && typeof packageIdentity.version === "string" && typeof packageIdentity.name === "string"
    })).toBe(true)
  })

  test("infers an atomic multi-head subflow and follows its dynamic join reference", async () => {
    runtime = await EditorTypeSystemRuntime.create()
    const identity = (id: string, name: string) => ({ id, version: "0.1.0", name })
    const packageNode = (id: string, packageId: string, name: string, params: Record<string, unknown>, parentId?: string, type: Node["type"] = "custom"): Node => ({
      id,
      type,
      parentId,
      position: { x: 0, y: 0 },
      data: {
        package: identity(packageId, name),
        name: id,
        params,
        ...(packageId === "core.add" ? { inputsCount: 2 } : {}),
      },
    })
    const nodes: Node[] = [
      packageNode("input", "core.input", "Input", { shape: ["B", "T", 128], dtype: "float32" }),
      packageNode("mha", "core.horizontal-repeat", "Horizontal Repeat", {
        times: 2,
        join: { id: "core.concat", version: "^0.1.0", parameters: { dim: -1 } },
      }, undefined, "subflow"),
      packageNode("head", "core.repeat", "Repeat", { times: 1 }, "mha", "subflow"),
      packageNode("fork", "core.fork", "Fork", {}, "head"),
      packageNode("q", "core.linear", "Linear", { in_features: 128, out_features: 32, dtype: "float32" }, "head"),
      packageNode("k", "core.linear", "Linear", { in_features: 128, out_features: 32, dtype: "float32" }, "head"),
      packageNode("v", "core.linear", "Linear", { in_features: 128, out_features: 32, dtype: "float32" }, "head"),
      packageNode("qk", "core.add", "Add", {}, "head", "join"),
      packageNode("qkv", "core.add", "Add", {}, "head", "join"),
    ]
    const edge = (source: string, target: string, index = 0, parentId?: string): Edge => ({
      id: `${source}-${target}`,
      source,
      target,
      sourceHandle: "out",
      targetHandle: index ? `in-${index}` : "in-0",
      type: "editable",
      data: { parentId },
    })
    const edges: Edge[] = [
      edge("input", "mha"),
      edge("fork", "q"), edge("fork", "k"), edge("fork", "v"),
      edge("q", "qk", 0), edge("k", "qk", 1),
      edge("qk", "qkv", 0), edge("v", "qkv", 1),
    ]
    const concatResult = runtime.infer({ nodes, edges })
    expect(concatResult.nodes.get("mha")).toEqual({ status: "success", output: { shape: ["B", "T", 64], dtype: "float32" } })

    const addNode = nodes.find((node) => node.id === "mha")!
    addNode.data = {
      ...addNode.data,
      params: { times: 2, join: { id: "core.add", version: "^0.1.0", parameters: {} } },
    }
    const addResult = runtime.infer({ nodes, edges })
    expect(addResult.nodes.get("mha")).toEqual({ status: "success", output: { shape: ["B", "T", 32], dtype: "float32" } })
  })

  test("refreshes package inference after an editor parameter update", async () => {
    runtime = await EditorTypeSystemRuntime.create()
    const source = new MemoryDiagram()
    const input = source.addPackageNode({ id: "core.input", version: "0.1.0", name: "Input" }, "input", 0, 0, {
      params: { shape: ["B", 8], dtype: "float32" },
    })
    const linear = source.addPackageNode({ id: "core.linear", version: "0.1.0", name: "Linear" }, "layer", 0, 100, {
      params: { in_features: 8, out_features: 4, dtype: "float32" },
    })
    source.addEdge(input.id, linear.id)
    expect(runtime.infer({ nodes: source.nodes, edges: source.edges }).nodes.get(linear.id)).toEqual({
      status: "success", output: { shape: ["B", 4], dtype: "float32" },
    })

    const reactiveParams = new Proxy({ in_features: 8, out_features: 4, dtype: "float16" }, {})
    source.updatePackageNode(linear.id, { id: "core.linear", version: "0.1.0", name: "Linear" }, "layer", {
      params: reactiveParams,
    })
    expect(source.nodes.find((node) => node.id === linear.id)?.data.params).toEqual({
      in_features: 8, out_features: 4, dtype: "float16",
    })
    expect(runtime.infer({ nodes: source.nodes, edges: source.edges }).nodes.get(linear.id)).toEqual({
      status: "error", message: "Linear expects dtype float16, got float32",
    })
  })

  test("preserves a resized collapsed subflow when other package fields are saved", () => {
    const diagram = new MemoryDiagram()
    const subflow = diagram.addPackageNode(
      { id: "core.subflow-proxy", version: "0.1.0", name: "Subflow" },
      "subflow",
      0,
      0,
      { width: 250, height: 50 },
    )
    diagram.nodes = diagram.nodes.map((node) => node.id === subflow.id
      ? {
          ...node,
          data: { ...node.data, isCollapsed: true, oldWidth: 640, oldHeight: 360 },
        }
      : node)

    diagram.updatePackageNode(
      subflow.id,
      { id: "core.subflow-proxy", version: "0.1.0", name: "Subflow" },
      "subflow",
      { name: "Encoder" },
    )

    const saved = diagram.nodes.find((node) => node.id === subflow.id)
    expect(saved).toMatchObject({
      width: 250,
      height: 50,
      data: { isCollapsed: true, oldWidth: 640, oldHeight: 360, name: "Encoder" },
    })
  })
})

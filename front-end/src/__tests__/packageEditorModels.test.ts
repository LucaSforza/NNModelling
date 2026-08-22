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
  public stereotypes = []
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
})

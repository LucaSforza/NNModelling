import { afterEach, describe, expect, test } from "vitest"

import { DiagramCore } from "../core/DiagramCore"
import type { Node, PackageIdentity } from "../core/types"
import { coreForkPackage } from "../type-system/bundled/core-fork"
import { coreInputPackage } from "../type-system/bundled/core-input"
import { coreOutputPackage } from "../type-system/bundled/core-output"
import mseManifest from "../../../stereotype-packages/core/mse-loss/manifest.json?raw"
import mseDefinition from "../../../stereotype-packages/core/mse-loss/stereotype.json?raw"
import mseInference from "../../../stereotype-packages/core/mse-loss/inference.lua?raw"
import { TypeSystemHost } from "../type-system/host"
import { PackageGraphScheduler } from "../type-system/graph/scheduler"

const inputIdentity = { id: "core.input", version: "0.1.0", name: "Input" }
const forkIdentity = { id: "core.fork", version: "0.1.0", name: "Fork" }
const hosts: TypeSystemHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.dispose()
})

function packageNode(id: string, identity: PackageIdentity, params: Record<string, unknown> = {}): Node {
  return {
    id,
    type: "custom",
    position: { x: 0, y: 0 },
    data: { package: identity, name: identity.name, params, ...(identity.id === "core.input" ? { inputBinding: "input" } : {}) },
  } as Node
}

async function createScheduler(): Promise<PackageGraphScheduler> {
  const msePackage = { resources: { "manifest.json": mseManifest, "stereotype.json": mseDefinition, "inference.lua": mseInference } }
  const host = await TypeSystemHost.create([coreInputPackage, coreForkPackage, coreOutputPackage, msePackage])
  hosts.push(host)
  await host.activate(inputIdentity)
  await host.activate(forkIdentity)
  await host.activate({ id: "core.output", version: "0.1.0", name: "Output" })
  await host.activate({ id: "core.mse-loss", version: "0.1.0", name: "MSE Loss" })
  return new PackageGraphScheduler(host)
}

describe("versioned package graph inference", () => {
  test("preserves the tensor through Input -> Fork", async () => {
    const scheduler = await createScheduler()
    const result = scheduler.infer({
      nodes: [
        packageNode("input", inputIdentity, { shape: ["B", 32], dtype: "float32" }),
        packageNode("fork", forkIdentity),
      ],
      edges: [{ id: "e1", source: "input", target: "fork", sourceHandle: "out", targetHandle: "in" }],
    })

    expect(result.order).toEqual(["input", "fork"])
    expect(result.complete).toBe(true)
    expect(result.terminals).toEqual(["fork"])
    expect(result.nodes.get("input")).toEqual({ status: "success", output: { shape: ["B", 32], dtype: "float32" } })
    expect(result.nodes.get("fork")).toEqual({ status: "success", output: { shape: ["B", 32], dtype: "float32" } })
  })

  test("keeps resolved upstream regions when a downstream region is disconnected", async () => {
    const scheduler = await createScheduler()
    const result = scheduler.infer({
      nodes: [
        packageNode("input", inputIdentity, { shape: ["B", 8], dtype: "float16" }),
        packageNode("fork", forkIdentity),
      ],
      edges: [],
    })

    expect(result.complete).toBe(false)
    expect(result.terminals).toEqual(["input", "fork"])
    expect(result.nodes.get("input")?.status).toBe("success")
    expect(result.nodes.get("fork")).toEqual({ status: "unresolved", reason: "package 'core.fork' requires one graph input" })
  })

  test("classifies zero, one, and multiple terminal states", async () => {
    const scheduler = await createScheduler()
    const input = packageNode("input", inputIdentity, { shape: ["B", 8], dtype: "float32" })
    const fork = packageNode("fork", forkIdentity)
    expect(scheduler.infer({ nodes: [input], edges: [{ id: "cycle", source: "input", target: "input" }] }).complete).toBe(false)
    expect(scheduler.infer({ nodes: [input], edges: [] }).terminals).toEqual(["input"])
    expect(scheduler.infer({ nodes: [input, fork], edges: [] }).terminals).toEqual(["input", "fork"])
  })

  test("accepts explicit prediction and objective terminals", async () => {
    const scheduler = await createScheduler()
    const input = packageNode("input", inputIdentity, { shape: ["B", 8], dtype: "float32" })
    const fork = packageNode("fork", forkIdentity)
    const output = packageNode("output", { id: "core.output", version: "0.1.0", name: "Output" })
    const loss = packageNode("loss", { id: "core.mse-loss", version: "0.1.0", name: "MSE Loss" })
    const edges = [
      { id: "input-fork", source: "input", target: "fork", sourceHandle: "out", targetHandle: "in" },
      { id: "fork-output", source: "fork", target: "output", sourceHandle: "out", targetHandle: "in" },
      { id: "fork-loss", source: "fork", target: "loss", sourceHandle: "out", targetHandle: "in" },
    ]
    const result = scheduler.infer({ nodes: [input, fork, output, loss], edges })
    expect(result.predictionTerminals).toEqual(["output"])
    expect(result.objectiveTerminals).toEqual(["loss"])
    expect(result.trainingComplete).toBe(true)
    expect(result.complete).toBe(true)
    expect(result.trainingDiagnostics).toEqual([])
  })

  test("reports disconnected outputs and missing objective roles", async () => {
    const scheduler = await createScheduler()
    const input = packageNode("input", inputIdentity, { shape: ["B", 8], dtype: "float32" })
    const output = packageNode("output", { id: "core.output", version: "0.1.0", name: "Output" })
    const result = scheduler.infer({
      nodes: [input, output],
      edges: [],
    })
    expect(result.trainingComplete).toBe(false)
    expect(result.trainingDiagnostics).toEqual(expect.arrayContaining([
      "training graph requires exactly one objective terminal; found 0",
      "training graph node 'output' is disconnected from the top-level input",
    ]))
  })

  test("round-trips exact package identity through DiagramCore persistence", () => {
    class MemoryDiagram extends DiagramCore {
      public nodes: Node[] = []
      public edges = []
    }
    const source = new MemoryDiagram()
    const created = source.addPackageModule(inputIdentity, "input", 10, 20, {
      params: { shape: ["B", 4], dtype: "float32" },
    })
    const target = new MemoryDiagram()
    expect(target.importFromJson(source.exportToJson())).toBe(true)
    expect(target.nodes[0]?.data.package).toEqual(inputIdentity)
    expect(target.nodes[0]?.data.name).toBe(created.data.name)
  })
})

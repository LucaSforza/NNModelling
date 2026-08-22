import { afterEach, describe, expect, test } from "vitest"

import { DiagramCore } from "../core/DiagramCore"
import type { Node } from "../core/types"
import { coreForkPackage } from "../type-system/bundled/core-fork"
import { coreInputPackage } from "../type-system/bundled/core-input"
import { TypeSystemHost } from "../type-system/host"
import { PackageGraphScheduler } from "../type-system/graph/scheduler"

const inputIdentity = { id: "core.input", version: "0.1.0", name: "Input" }
const forkIdentity = { id: "core.fork", version: "0.1.0", name: "Fork" }
const hosts: TypeSystemHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.dispose()
})

function packageNode(id: string, identity: typeof inputIdentity | typeof forkIdentity, params: Record<string, unknown> = {}): Node {
  return {
    id,
    type: "custom",
    position: { x: 0, y: 0 },
    data: { package: identity, name: identity.name, params },
  } as Node
}

async function createScheduler(): Promise<PackageGraphScheduler> {
  const host = await TypeSystemHost.create([coreInputPackage, coreForkPackage])
  hosts.push(host)
  await host.activate("core.input")
  await host.activate("core.fork")
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

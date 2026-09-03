import { afterEach, describe, expect, test } from "vitest"
import type { Node } from "@xyflow/svelte"

import { coreInputPackage } from "../type-system/bundled/core-input"
import { coreForkPackage } from "../type-system/bundled/core-fork"
import { TypeSystemHost } from "../type-system/host"
import { PackageGraphScheduler } from "../type-system/graph/scheduler"

const hosts: TypeSystemHost[] = []
const ref = (id: string) => ({ id, version: "0.1.0", name: id })

afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.dispose()
})

function input(id: string, binding: string): Node {
  return {
    id,
    type: "custom",
    position: { x: 0, y: 0 },
    data: { package: ref("core.input"), inputBinding: binding, params: {} },
  } as Node
}

const dataset = (batchSize: number, width: number) => ({
  definition: {
    schemaVersion: 1 as const,
    id: "demo.images",
    version: "1.0.0",
    name: "Images",
    parameters: [{ name: "B", type: "integer" as const, required: true }],
    batch: { inputs: { image: { shape: ["B", width], dtype: "float32" as const } }, targets: {} },
  },
  parameters: { B: batchSize },
})

describe("dataset-scoped graph Input inference", () => {
  test("leaves Input-dependent regions unresolved without a selected dataset", async () => {
    const host = await TypeSystemHost.create([coreInputPackage, coreForkPackage])
    hosts.push(host)
    await host.activate(ref("core.input"))
    await host.activate(ref("core.fork"))
    const result = new PackageGraphScheduler(host).infer({
      nodes: [input("image", "image"), { id: "fork", type: "custom", position: { x: 0, y: 0 }, data: { package: ref("core.fork"), params: {} } } as Node],
      edges: [{ id: "edge", source: "image", target: "fork", sourceHandle: "out", targetHandle: "in" }],
    })
    expect(result.nodes.get("image")).toEqual({ status: "unresolved", reason: "dataset selection is required to resolve Input 'image'" })
    expect(result.nodes.get("fork")?.status).toBe("unresolved")
  })

  test("resolves multiple named Inputs independently and recomputes on dataset changes", async () => {
    const host = await TypeSystemHost.create([coreInputPackage])
    hosts.push(host)
    await host.activate(ref("core.input"))
    const scheduler = new PackageGraphScheduler(host)
    const nodes = [input("image", "image"), input("mask", "mask")]
    const first = scheduler.infer({ nodes, edges: [] }, {
      definition: { ...dataset(2, 28).definition, batch: { inputs: {
        image: { shape: ["B", 28], dtype: "float32" as const },
        mask: { shape: ["B", 28], dtype: "uint8" as const },
      }, targets: {} } },
      parameters: { B: 2 },
    })
    expect(first.nodes.get("image")).toEqual({ status: "success", output: { shape: [2, 28], dtype: "float32" } })
    expect(first.nodes.get("mask")).toEqual({ status: "success", output: { shape: [2, 28], dtype: "uint8" } })

    const second = scheduler.infer({ nodes, edges: [] }, {
      definition: { ...dataset(4, 64).definition, batch: { inputs: {
        image: { shape: ["B", 64], dtype: "float16" as const },
        mask: { shape: ["B", 64], dtype: "int64" as const },
      }, targets: {} } },
      parameters: { B: 4 },
    })
    expect(second.nodes.get("image")).toEqual({ status: "success", output: { shape: [4, 64], dtype: "float16" } })
    expect(second.nodes.get("mask")).toEqual({ status: "success", output: { shape: [4, 64], dtype: "int64" } })
  })

  test("reports invalid dataset selections before graph propagation", async () => {
    const host = await TypeSystemHost.create([coreInputPackage])
    hosts.push(host)
    await host.activate(ref("core.input"))
    const result = new PackageGraphScheduler(host).infer({ nodes: [input("image", "image")], edges: [] }, {
      ...dataset(0, 28),
      parameters: { B: 0 },
    })
    expect(result.nodes.get("image")).toEqual(expect.objectContaining({
      status: "error",
      message: expect.stringContaining("invalid-dimension-value"),
    }))
  })
})

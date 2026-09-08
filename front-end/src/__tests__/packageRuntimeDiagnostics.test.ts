import { afterEach, describe, expect, test } from "vitest"

import { PackageRuntimeDiagnosticCollection } from "../type-system/diagnostics"
import { TypeSystemHost } from "../type-system/host"
import { coreInputPackage } from "../type-system/bundled/core-input"
import { PackageGraphScheduler } from "../type-system/graph/scheduler"

const hosts: TypeSystemHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.dispose()
})

describe("package/runtime diagnostics", () => {
  test("replaces repeated occurrences and resolves recovered inference", () => {
    const diagnostics = new PackageRuntimeDiagnosticCollection()
    diagnostics.record({
      occurrenceId: "inference:test.layer@1.0.0:node",
      phase: "inference",
      packageId: "test.layer",
      packageVersion: "1.0.0",
      nodeId: "node",
      message: "first cause",
    })
    diagnostics.record({
      occurrenceId: "inference:test.layer@1.0.0:node",
      phase: "inference",
      packageId: "test.layer",
      packageVersion: "1.0.0",
      nodeId: "node",
      message: "updated cause",
    })

    expect(diagnostics.snapshot()).toHaveLength(1)
    expect(diagnostics.snapshot()[0]?.message).toBe("updated cause")
    expect(diagnostics.resolve("inference:test.layer@1.0.0:node")).toBe(true)
    expect(diagnostics.snapshot()).toEqual([])
  })

  test("dataset-scoped Input inference uses the injected boundary capability", async () => {
    const host = await TypeSystemHost.create([{
      resources: {
        ...coreInputPackage.resources as Record<string, string>,
        "inference.lua": "return function(context, parameters, services) return services.resolve_input(parameters.binding) end",
      },
    }])
    hosts.push(host)
    await host.activate({ id: "core.input", version: "0.1.0", name: "Input" })

    const scheduler = new PackageGraphScheduler(host)
    host.setDatasetCatalog([{
      schemaVersion: 1, id: "test.images", version: "1.0.0", name: "Images",
      parameters: [{ name: "B", type: "integer", required: true }],
      batch: { inputs: { image: { shape: ["B", 4], dtype: "float32" } }, targets: {} },
    }])
    const result = scheduler.infer({
      nodes: [{ id: "input-node", type: "custom", position: { x: 0, y: 0 }, data: {
        package: { id: "core.input", version: "0.1.0", name: "Input" }, params: { binding: "image" },
      } }],
      edges: [],
    }, {
      definition: { schemaVersion: 1, id: "test.images", version: "1.0.0", name: "Images", parameters: [{ name: "B", type: "integer", required: true }], batch: { inputs: { image: { shape: ["B", 4], dtype: "float32" } }, targets: {} } },
      parameters: { B: 4 },
    })
    expect(result.nodes.get("input-node")).toEqual({ status: "success", output: { shape: [4, 4], dtype: "float32" } })
    expect(host.runtimeDiagnostics()).toEqual([])
  })
})

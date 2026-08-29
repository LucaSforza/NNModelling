import { afterEach, describe, expect, test } from "vitest"

import type { Node } from "@xyflow/svelte"
import { coreForkPackage } from "../type-system/bundled/core-fork"
import { coreInputPackage } from "../type-system/bundled/core-input"
import { TypeSystemHost } from "../type-system/host"
import { PackageGraphScheduler } from "../type-system/graph/scheduler"

const hosts: TypeSystemHost[] = []
const ref = (id: string) => ({ id, version: "0.1.0", name: id })

afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.dispose()
})

function node(id: string, packageId: string, params: Record<string, unknown> = {}): Node {
  return {
    id,
    type: "custom",
    position: { x: 0, y: 0 },
    data: { package: ref(packageId), name: id, params },
  } as Node
}

describe("package graph failure scope", () => {
  test("faults only the unavailable branch and continues an independent branch", async () => {
    const host = await TypeSystemHost.create([coreInputPackage, coreForkPackage])
    hosts.push(host)
    await host.activate(ref("core.input"))
    await host.activate(ref("core.fork"))
    const scheduler = new PackageGraphScheduler(host)
    const result = scheduler.infer({
      nodes: [
        node("input", "core.input", { shape: ["B", 4], dtype: "float32" }),
        node("good", "core.fork"),
        node("missing", "external.layer"),
        node("after-missing", "external.layer"),
      ],
      edges: [
        { id: "good-edge", source: "input", target: "good", sourceHandle: "out", targetHandle: "in" },
        { id: "missing-edge", source: "missing", target: "after-missing", sourceHandle: "out", targetHandle: "in" },
      ],
    })

    expect(result.nodes.get("input")?.status).toBe("success")
    expect(result.nodes.get("good")?.status).toBe("success")
    expect(result.nodes.get("missing")).toEqual(expect.objectContaining({
      status: "fault",
      fault: expect.objectContaining({ packageId: "external.layer", phase: "activation" }),
    }))
    expect(result.nodes.get("after-missing")).toEqual(result.nodes.get("missing"))
    expect(host.runtimeDiagnostics()).toEqual(expect.arrayContaining([
      expect.objectContaining({ packageId: "external.layer", nodeId: "missing", phase: "activation" }),
    ]))
  })
})

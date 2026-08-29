import { describe, expect, test } from "vitest"

import { DiagramCore } from "../core/DiagramCore"
import type { Edge, Node } from "../core/types"

class MemoryDiagram extends DiagramCore {
  public nodes: Node[] = []
  public edges: Edge[] = []
}

describe("canonical package project persistence", () => {
  test("writes only exact package id and version", () => {
    const diagram = new MemoryDiagram()
    diagram.addPackageModule({ id: "vendor.layer", version: "1.0.0", name: "Display name" }, "layer", 0, 0)
    const saved = JSON.parse(diagram.exportToJson()) as { nodes: Node[] }
    expect(saved.nodes[0]?.data.package).toEqual({ id: "vendor.layer", version: "1.0.0" })
  })

  test("reads the current redundant name field but does not use it as identity", () => {
    const diagram = new MemoryDiagram()
    const project = JSON.stringify({
      nodes: [{ id: "node", type: "custom", position: { x: 0, y: 0 }, data: {
        package: { id: "vendor.layer", version: "1.0.0", name: "stale display" }, params: {}, name: "Layer",
      } }],
      edges: [],
    })
    expect(diagram.importFromJson(project)).toBe(true)
    expect(diagram.nodes[0]?.data.package).toMatchObject({ id: "vendor.layer", version: "1.0.0" })
    expect(JSON.parse(diagram.exportToJson()).nodes[0].data.package).toEqual({ id: "vendor.layer", version: "1.0.0" })
  })

  test("rejects references without an exact id or version", () => {
    const diagram = new MemoryDiagram()
    expect(diagram.importFromJson(JSON.stringify({
      nodes: [{ id: "node", type: "custom", position: { x: 0, y: 0 }, data: { package: { name: "guess me" }, params: {} } }],
      edges: [],
    }))).toBe(false)
    expect(diagram.nodes).toEqual([])
  })
})

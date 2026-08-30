import { describe, expect, test } from "vitest"

import { DiagramCore } from "../core/DiagramCore"
import { parseModelManifest, type Edge, type ModelManifest, type Node } from "../core/types"
import { ProjectModelWriter } from "../project-workspace"

class MemoryDiagram extends DiagramCore {
  public nodes: Node[] = []
  public edges: Edge[] = []
}

describe("canonical package project persistence", () => {
  const resnetManifest: ModelManifest = {
    schemaVersion: 1,
    id: "example.resnet-mnist",
    version: "0.1.0",
    name: "ResNet",
    customPackages: [],
  }

  const vaeManifest: ModelManifest = {
    schemaVersion: 1,
    id: "example.vae-mnist",
    version: "0.1.0",
    name: "Variational Autoencoder",
    description: "MNIST variational autoencoder",
    customPackages: [
      { id: "example.vae.sampling", version: "0.1.0", path: "packages/sampling" },
      { id: "example.vae.kl-divergence", version: "0.1.0", path: "packages/kl-divergence" },
    ],
  }

  test("round-trips an empty custom package set", () => {
    const source = new MemoryDiagram()
    source.modelManifest = resnetManifest
    const loaded = new MemoryDiagram()

    expect(loaded.importFromJson(source.exportToJson())).toBe(true)
    expect(loaded.modelManifest).toEqual(resnetManifest)
    expect(JSON.parse(loaded.exportToJson()).manifest).toEqual(resnetManifest)
  })

  test("round-trips exact non-empty custom package references", () => {
    const source = new MemoryDiagram()
    source.modelManifest = vaeManifest
    const loaded = new MemoryDiagram()

    expect(loaded.importFromJson(source.exportToJson())).toBe(true)
    expect(loaded.modelManifest).toEqual(vaeManifest)
    expect(JSON.parse(loaded.exportToJson()).manifest.customPackages).toEqual(vaeManifest.customPackages)
  })

  test("rejects invalid manifests before changing graph state", () => {
    const diagram = new MemoryDiagram()
    diagram.modelManifest = resnetManifest
    const node = diagram.addPackageModule({ id: "core.input", version: "0.1.0", name: "Input" }, "input", 10, 20)
    const before = diagram.getSnapshot()
    const invalid = JSON.stringify({
      manifest: { ...vaeManifest, customPackages: [{ id: "example.vae.sampling", version: "0.1.0", path: "../sampling" }] },
      nodes: [node],
      edges: [],
    })

    expect(diagram.importFromJson(invalid)).toBe(false)
    expect(diagram.nodes).toEqual(before.nodes)
    expect(diagram.edges).toEqual(before.edges)
    expect(diagram.modelManifest).toEqual(before.manifest)
  })

  test.each([
    ["duplicate identities", { ...vaeManifest, customPackages: [vaeManifest.customPackages[0], vaeManifest.customPackages[0]] }],
    ["duplicate paths", { ...vaeManifest, customPackages: [vaeManifest.customPackages[0], { ...vaeManifest.customPackages[1], path: vaeManifest.customPackages[0].path }] }],
    ["malformed identity", { ...vaeManifest, customPackages: [{ ...vaeManifest.customPackages[0], id: "Not A Package" }] }],
  ])("reports %s as an actionable validation error", (_label, manifest) => {
    expect(() => parseModelManifest(manifest)).toThrow(/model manifest customPackages/)
  })

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
      manifest: resnetManifest,
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
      manifest: resnetManifest,
    }))).toBe(false)
    expect(diagram.nodes).toEqual([])
  })

  test("persists every accepted graph callback in order through one writer", async () => {
    const writes: string[] = []
    const writer = new ProjectModelWriter(async (modelJson) => {
      writes.push(modelJson)
    })
    const diagram = new MemoryDiagram()
    const unsubscribe = diagram.onGraphChanged(() => {
      void writer.save(diagram.exportToJson())
    })

    diagram.modelManifest = resnetManifest
    diagram.addPackageModule({ id: "core.input", version: "0.1.0", name: "Input" }, "input", 0, 0)
    diagram.addPackageModule({ id: "core.output", version: "0.1.0", name: "Output" }, "output", 20, 0)
    await new Promise((resolve) => setTimeout(resolve, 0))
    unsubscribe()

    expect(writes).toHaveLength(2)
    expect(JSON.parse(writes.at(-1)!).nodes).toHaveLength(2)
    expect(writer.status).toMatchObject({ state: "saved", latestSavedVersion: 2 })
  })
})

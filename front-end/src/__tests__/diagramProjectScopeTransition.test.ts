import { afterAll, afterEach, describe, expect, test } from "vitest"

import { Diagram } from "../Diagram.svelte"
import type { EditorTypeSystemRuntime } from "../type-system/editor-runtime"
import { stubWindow, unstubWindow } from "./helpers"

stubWindow()

const packageReference = { id: "model.transition-probe", version: "1.0.0", path: "packages/transition-probe" }
const oldManifest = {
  schemaVersion: 1 as const,
  id: "model.old",
  version: "1.0.0",
  name: "Old model",
  customPackages: [packageReference],
}
const oldModel = JSON.stringify({ manifest: oldManifest, nodes: [], edges: [] })
const newModel = JSON.stringify({
  manifest: { schemaVersion: 1, id: "model.new", version: "1.0.0", name: "New model", customPackages: [] },
  nodes: [],
  edges: [],
})
const oldResources = {
  "packages/transition-probe/manifest.json": JSON.stringify({
    schemaVersion: 1,
    id: packageReference.id,
    version: packageReference.version,
    dependencies: {},
    entrypoints: {
      definition: "stereotype.json",
      inference: { language: "lua", file: "inference.lua" },
    },
  }),
  "packages/transition-probe/stereotype.json": JSON.stringify({
    name: "Transition probe",
    kind: "layer",
    view: { color: "#123456", width: 100, height: 60 },
    parameters: {},
  }),
  "packages/transition-probe/inference.lua": "return function(context) return { status = 'success', output = context.inputs[1] } end",
}

const diagrams: Diagram[] = []

afterEach(async () => {
  for (const diagram of diagrams.splice(0)) {
    await (diagram as unknown as { packageTypeRuntime: EditorTypeSystemRuntime }).packageTypeRuntime.dispose()
  }
})
afterAll(() => unstubWindow())

describe("Diagram project scope transition", () => {
  test("blocks old-scope package additions while an import swaps the runtime", async () => {
    const diagram = new Diagram()
    diagrams.push(diagram)
    await diagram.waitForPackageRuntime()
    await expect(diagram.importProjectJson(oldModel, oldResources)).resolves.toBe(true)
    expect(diagram.packageCatalog.some(({ id, version }) => id === packageReference.id && version === packageReference.version)).toBe(true)

    const runtime = (diagram as unknown as { packageTypeRuntime: EditorTypeSystemRuntime }).packageTypeRuntime
    const mutableRuntime = runtime as EditorTypeSystemRuntime & { commitModelScope: typeof runtime.commitModelScope }
    const originalCommit = runtime.commitModelScope.bind(runtime)
    let enteredCommit!: () => void
    let releaseCommit!: () => void
    const commitEntered = new Promise<void>((resolve) => { enteredCommit = resolve })
    const holdCommit = new Promise<void>((resolve) => { releaseCommit = resolve })
    mutableRuntime.commitModelScope = async (scope) => {
      enteredCommit()
      await holdCommit
      return originalCommit(scope)
    }

    const importing = diagram.importProjectJson(newModel)
    try {
      await commitEntered
      expect(diagram.packageCatalog).toEqual([])
      expect(() => diagram.addPackageNode(
        { id: packageReference.id, version: packageReference.version, name: "Transition probe" },
        "layer",
        30,
        30,
      )).toThrow(/unavailable in the active project scope/)
      releaseCommit()
      await expect(importing).resolves.toBe(true)
      expect(diagram.packageCatalog.some(({ id }) => id === packageReference.id)).toBe(false)
      expect(diagram.nodes.some((node) => (
        node.data?.package &&
        (node.data.package as { id?: string; version?: string }).id === packageReference.id
      ))).toBe(false)
    } finally {
      releaseCommit()
      mutableRuntime.commitModelScope = originalCommit
      await importing.catch(() => undefined)
    }
  })
})

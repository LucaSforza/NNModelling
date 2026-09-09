import { describe, expect, test } from "vitest"
import { createPathProjectSession, type ProjectPathPayload } from "../project-workspace/path"
import { ProjectDatasetAuthoringCoordinator } from "../project-workspace/dataset-authoring"

const MODEL = JSON.stringify({ manifest: { schemaVersion: 2, id: "demo", version: "0.1.0", name: "Demo", customPackages: [], customDatasets: [] }, nodes: [], edges: [] })
const DATASET_REQUEST = {
  id: "demo.remote",
  version: "1.0.0",
  directory: "datasets/remote",
  name: "Remote",
  parameters: [],
  inputs: [{ name: "image", shape: ["B", 1, 2, 2], dtype: "float32" as const }],
  targets: [],
  dataFiles: [{ path: "sample.bin", bytes: Uint8Array.from([1, 2, 3]) }],
}

describe("MCP-selected project workspace", () => {
  test("keeps handles local and forwards ordered model saves", async () => {
    const saved: unknown[] = []
    const payload: ProjectPathPayload = {
      projectPath: "/projects/demo",
      modelJson: MODEL,
      resources: { "model.json": { encoding: "utf8", data: MODEL } },
    }
    const session = await createPathProjectSession(payload, async (operation) => { saved.push(operation) })
    const changed = MODEL.replace('"name":"Demo"', '"name":"Changed"')
    await session.save(changed)
    expect(saved).toEqual([{ kind: "write", path: "model.json", encoding: "utf8", data: changed }])
    expect(session.resources).toEqual({ "model.json": MODEL })
    expect("projectPath" in session).toBe(false)
    expect("directory" in session).toBe(true)
  })

  test("creates missing directories only when requested", async () => {
    const session = await createPathProjectSession({
      projectPath: "/projects/demo",
      modelJson: MODEL,
      resources: { "model.json": { encoding: "utf8", data: MODEL } },
    }, async () => undefined)

    await expect(session.directory.getDirectoryHandle("datasets")).rejects.toMatchObject({ name: "NotFoundError" })
    const datasets = await session.directory.getDirectoryHandle("datasets", { create: true })
    const projectDataset = await datasets.getDirectoryHandle("minimal", { create: true })
    await projectDataset.getDirectoryHandle("data", { create: true })

    const entries: string[] = []
    if (projectDataset.entries) {
      for await (const [name] of projectDataset.entries()) entries.push(name)
    }
    expect(entries).toEqual(["data"])
  })

  test("persists binary writes and removes directories only after remote acknowledgement", async () => {
    const operations: unknown[] = []
    const session = await createPathProjectSession({
      projectPath: "/projects/demo",
      modelJson: MODEL,
      resources: { "model.json": { encoding: "utf8", data: MODEL } },
    }, async (operation) => { operations.push(operation) })

    const datasets = await session.directory.getDirectoryHandle("datasets", { create: true })
    const dataset = await datasets.getDirectoryHandle("demo", { create: true })
    const file = await dataset.getFileHandle("data/sample.bin", { create: true })
    const writable = await file.createWritable()
    await writable.write(Uint8Array.from([0, 127, 255]))
    await writable.close()
    expect(operations).toContainEqual({ kind: "write", path: "datasets/demo/data/sample.bin", encoding: "base64", data: "AH//" })

    await datasets.removeEntry("demo", { recursive: true })
    expect(operations.at(-1)).toEqual({ kind: "remove", path: "datasets/demo", recursive: true })
    const entries: string[] = []
    for await (const [name] of datasets.entries!()) entries.push(name)
    expect(entries).toEqual([])
  })

  test("does not expose an unacknowledged write in the local directory", async () => {
    const session = await createPathProjectSession({
      projectPath: "/projects/demo",
      modelJson: MODEL,
      resources: { "model.json": { encoding: "utf8", data: MODEL } },
    }, async () => { throw new Error("bridge disconnected") })
    const datasets = await session.directory.getDirectoryHandle("datasets", { create: true })
    const file = await (await datasets.getDirectoryHandle("demo", { create: true })).getFileHandle("dataset.json", { create: true })
    const writable = await file.createWritable()
    await expect(writable.write("{}" as string)).rejects.toThrow("bridge disconnected")
    const names: string[] = []
    for await (const [name] of datasets.entries!()) names.push(name)
    expect(names).toEqual(["demo"])
  })

  test("keeps the dataset directory and manifest when remote removal is rejected", async () => {
    let rejectRemoval = false
    const session = await createPathProjectSession({
      projectPath: "/projects/demo",
      modelJson: MODEL,
      resources: { "model.json": { encoding: "utf8", data: MODEL } },
    }, async (operation) => {
      if (rejectRemoval && operation.kind === "remove") throw new Error("bridge disconnected")
    })
    const coordinator = new ProjectDatasetAuthoringCoordinator(session)
    await coordinator.author(DATASET_REQUEST)
    rejectRemoval = true

    const target = { id: DATASET_REQUEST.id, version: DATASET_REQUEST.version, path: DATASET_REQUEST.directory }
    await expect(coordinator.delete(target)).rejects.toThrow("bridge disconnected")
    expect(coordinator.listProjectDatasets()).toEqual([target])
    const datasets = await session.directory.getDirectoryHandle("datasets")
    await expect(datasets.getDirectoryHandle("remote")).resolves.toBeDefined()
    const model = await (await session.directory.getFileHandle("model.json")).getFile()
    expect(JSON.parse(await model.text!()).manifest.customDatasets).toEqual([target])
  })
})

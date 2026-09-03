import { describe, expect, test } from "vitest"
import { createPathProjectSession, type ProjectPathPayload } from "../project-workspace/path"

const MODEL = JSON.stringify({ manifest: { schemaVersion: 2, id: "demo", version: "0.1.0", name: "Demo", customPackages: [], customDatasets: [] }, nodes: [], edges: [] })

describe("MCP-selected project workspace", () => {
  test("keeps handles local and forwards ordered model saves", async () => {
    const saved: string[] = []
    const payload: ProjectPathPayload = {
      projectPath: "/projects/demo",
      modelJson: MODEL,
      resources: { "model.json": { encoding: "utf8", data: MODEL } },
    }
    const session = createPathProjectSession(payload, async (modelJson) => { saved.push(modelJson) })
    const changed = MODEL.replace('"name":"Demo"', '"name":"Changed"')
    await session.save(changed)
    expect(saved).toEqual([changed])
    expect(session.resources).toEqual({ "model.json": MODEL })
    expect("projectPath" in session).toBe(false)
    expect("directory" in session).toBe(true)
  })

  test("creates missing directories only when requested", async () => {
    const session = createPathProjectSession({
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
})

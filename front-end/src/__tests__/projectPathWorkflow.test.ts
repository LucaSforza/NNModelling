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
})

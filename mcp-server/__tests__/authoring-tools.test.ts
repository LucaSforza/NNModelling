import { describe, expect, it, vi } from "vitest"
import type { ServerContext } from "../src/server"
import type { BrowserRPCClient } from "../src/browser-client"
import * as authoringTools from "../src/tools/authoring"
import { z } from "zod"

function createContext() {
  const call = vi.fn().mockResolvedValue({ status: "ok" })
  const ctx = { browser: { call } as unknown as BrowserRPCClient } as ServerContext
  return { ctx, call }
}

async function invoke<S extends z.ZodTypeAny>(
  tool: { schema: S; handler(ctx: ServerContext, input: z.infer<S>): Promise<unknown> },
  ctx: ServerContext,
  input: unknown,
) {
  return tool.handler(ctx, tool.schema.parse(input))
}

describe("project authoring tools", () => {
  it("exports exactly the four auto-discoverable authoring tools", () => {
    expect(Object.keys(authoringTools).sort()).toEqual([
      "create_dataset",
      "create_stereotype",
      "delete_dataset",
      "delete_stereotype",
    ])
    for (const tool of Object.values(authoringTools)) {
      expect(tool.schema).toBeDefined()
      expect(tool.handler).toBeTypeOf("function")
    }
  })

  it("forwards the complete stereotype form request and returns the browser result", async () => {
    const { ctx, call } = createContext()
    const request = {
      id: "example.loss",
      version: "0.1.0",
      directory: "packages/example-loss",
      name: "Example loss",
      description: "A project-owned loss",
      kind: "loss",
      view: { color: "#123456", width: 180, height: 72 },
      dependencies: { "example.base": "^1.0.0" },
      parameters: [{
        name: "reduction",
        definition: { type: "string", choices: ["mean", "sum"], default: "mean", position: "bottom" },
      }],
      objective: { externalInputs: [{ name: "target", source: "batch.targets.target", transform: "flatten_batch" }] },
    }
    const browserResult = { id: request.id, version: request.version, path: request.directory }
    call.mockResolvedValue(browserResult)

    await expect(invoke(authoringTools.create_stereotype, ctx, request)).resolves.toEqual(browserResult)
    expect(call).toHaveBeenCalledWith("create_stereotype", request)
  })

  it("forwards dataset semantic fields and strict base64 file transport unchanged", async () => {
    const { ctx, call } = createContext()
    const request = {
      id: "example.dataset",
      version: "1.2.0",
      directory: "datasets/example-dataset",
      name: "Example dataset",
      description: "Tiny fixture",
      parameters: [{ name: "batch_size", type: "integer", required: true, default: 8 }],
      inputs: [{ name: "features", shape: ["B", 4], dtype: "float32" }],
      targets: [{ name: "labels", shape: ["B"], dtype: "int64" }],
      classes: { count: 2, names: ["negative", "positive"] },
      dataFiles: [{ path: "train.bin", dataBase64: "AAEC" }],
    }

    await invoke(authoringTools.create_dataset, ctx, request)
    expect(call).toHaveBeenCalledWith("create_dataset", request)
  })

  it("proxies a valid dataset identity to the selected browser tab", async () => {
    const { ctx, call } = createContext()
    const request = { id: "example.dataset", version: "1.2.0", path: "datasets/example-dataset" }
    await invoke(authoringTools.delete_dataset, ctx, request)
    expect(call).toHaveBeenCalledWith("delete_dataset", request)
  })

  it("proxies a valid stereotype identity to the selected browser tab", async () => {
    const { ctx, call } = createContext()
    const request = { id: "example.layer", version: "0.1.0", path: "packages/example-layer" }
    await invoke(authoringTools.delete_stereotype, ctx, request)
    expect(call).toHaveBeenCalledWith("delete_stereotype", request)
  })

  it.each(["AAE", "AA?=", "Zh=="])("rejects malformed or non-canonical base64 (%s) before browser RPC", async (dataBase64) => {
    const { ctx, call } = createContext()
    const request = {
      id: "example.dataset",
      version: "1.2.0",
      directory: "datasets/example-dataset",
      name: "Example dataset",
      parameters: [],
      inputs: [],
      targets: [],
      dataFiles: [{ path: "train.bin", dataBase64 }],
    }

    await expect(invoke(authoringTools.create_dataset, ctx, request)).rejects.toThrow()
    expect(call).not.toHaveBeenCalled()
  })

  it.each([
    { id: 42, version: "1.0.0", path: "datasets/example" },
    { id: "example.dataset", version: "1.0.0" },
    { id: "example.dataset", version: "1.0.0", path: "datasets/example", name: "display name" },
  ])("rejects malformed or non-exact delete identity before browser RPC", async (identity) => {
    const { ctx, call } = createContext()
    await expect(invoke(authoringTools.delete_dataset, ctx, identity)).rejects.toThrow()
    expect(call).not.toHaveBeenCalled()
  })

  it("leaves browser/domain errors visible to the MCP caller", async () => {
    const { ctx, call } = createContext()
    call.mockRejectedValue(new Error("stereotype is required by another package"))
    const request = { id: "example.layer", version: "0.1.0", path: "packages/example-layer" }

    await expect(invoke(authoringTools.delete_stereotype, ctx, request)).rejects.toThrow(
      "stereotype is required by another package",
    )
  })
})

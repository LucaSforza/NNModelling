import { describe, expect, test, vi } from "vitest"
import { BrowserRPCHandler } from "../sync/BrowserRPCHandler"
import type { ProjectAuthoringOperations } from "../project-workspace/authoring-service"

function harness() {
  const sent: Array<Record<string, unknown>> = []
  const diagram = {
    nodes: [], edges: [], packageCatalog: [], packageRuntimeReady: false,
    packageRuntimeDiagnostics: [{ occurrenceId: "runtime:one", severity: "fatal", phase: "activation", message: "one" }],
    typeResult: null,
    refreshTypes() { return { nodes: new Map(), order: [], terminals: [], complete: false } },
  } as any
  const handler: any = new BrowserRPCHandler(diagram, "ws://test")
  handler.ws = { readyState: 1, send(payload: string) { sent.push(JSON.parse(payload)) } }
  return { handler, diagram, sent }
}

describe("BrowserRPCHandler package diagnostics", () => {
  test("returns browser-owned diagnostics and readiness without a second state store", () => {
    const { handler, diagram, sent } = harness()
    handler.handleMessage({ data: JSON.stringify({ id: "diagnostics", method: "get_package_diagnostics", params: {} }) })
    expect(sent[0]?.result).toEqual({ packageRuntimeReady: false, packageRuntimeDiagnostics: diagram.packageRuntimeDiagnostics })
  })

  test("includes the same diagnostic objects in graph and type responses", () => {
    const { handler, diagram, sent } = harness()
    handler.handleMessage({ data: JSON.stringify({ id: "graph", method: "get_graph", params: {} }) })
    handler.handleMessage({ data: JSON.stringify({ id: "types", method: "get_type_info", params: {} }) })
    expect(sent[0]?.result).toMatchObject({ packageRuntimeReady: false, packageRuntimeDiagnostics: diagram.packageRuntimeDiagnostics })
    expect(sent[1]?.result).toMatchObject({ packageRuntimeReady: false, packageRuntimeDiagnostics: diagram.packageRuntimeDiagnostics })
    expect(sent[0]?.result?.packageRuntimeDiagnostics).toStrictEqual(sent[1]?.result?.packageRuntimeDiagnostics)
  })

  test("activates an installed exact package before asynchronous node creation", async () => {
    const packageMetadata = {
      id: "vendor.layer",
      version: "1.0.0",
      state: "installed",
      definition: { name: "Vendor Layer", kind: "layer", view: { color: "#fff", width: 100, height: 60 }, parameters: {} },
    }
    const nodes: any[] = []
    const diagram = {
      nodes,
      packageCatalog: [packageMetadata],
      activatePackage: async () => { packageMetadata.state = "active" },
      addPackageNode(identity: any, kind: string, x: number, y: number) {
        nodes.push({ id: "created", type: "custom", position: { x, y }, data: { package: identity, name: identity.name, kind } })
      },
    } as any
    const sent: Array<Record<string, unknown>> = []
    const handler: any = new BrowserRPCHandler(diagram, "ws://test")
    handler.ws = { readyState: 1, send(payload: string) { sent.push(JSON.parse(payload)) } }

    handler.handleMessage({ data: JSON.stringify({
      id: "create",
      method: "create_node",
      params: { package: { id: "vendor.layer", version: "1.0.0", name: "Vendor Layer", kind: "layer" }, position: { x: 10, y: 20 } },
    }) })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(nodes).toHaveLength(1)
    expect(sent[0]?.result).toMatchObject({ nodeId: "created", package: { id: "vendor.layer", version: "1.0.0" } })
  })
})

describe("BrowserRPCHandler startup project bridge", () => {
  test("routes path payloads before an editor exists and reports graph readiness truthfully", async () => {
    const sent: Array<Record<string, unknown>> = []
    const payload = { projectPath: "/projects/demo", modelJson: "{}", resources: {} }
    const handler: any = new BrowserRPCHandler(undefined, "ws://test", undefined, undefined, {
      open: async (value: unknown) => ({ status: "ok", project: value }),
      create: async () => ({ status: "ok" }),
    })
    handler.ws = { readyState: 1, send(payloadText: string) { sent.push(JSON.parse(payloadText)) } }
    handler.handleMessage({ data: JSON.stringify({ id: "open", method: "open_project", params: payload }) })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(sent[0]?.result).toMatchObject({ status: "ok", project: payload })

    handler.handleMessage({ data: JSON.stringify({ id: "graph", method: "get_graph", params: {} }) })
    expect(sent[1]?.error).toMatchObject({ code: "NO_ACTIVE_PROJECT" })
  })
})

describe("BrowserRPCHandler browser-owned persistence", () => {
  test("waits for the MCP acknowledgement before resolving a resource request", async () => {
    const { handler, sent } = harness()
    const pending = handler.request("project_resource", { projectPath: "/projects/demo", operation: { kind: "remove", path: "datasets/demo", recursive: true } })
    expect(sent[0]).toMatchObject({ method: "project_resource" })
    handler.handleMessage({ data: JSON.stringify({ id: sent[0].id, result: { status: "ok" } }) })
    await expect(pending).resolves.toEqual({ status: "ok" })
  })

  test("rejects a failed MCP persistence acknowledgement", async () => {
    const { handler, sent } = harness()
    const pending = handler.request("project_resource", { projectPath: "/projects/demo", operation: { kind: "write", path: "datasets/demo/dataset.json", encoding: "utf8", data: "{}" } })
    handler.handleMessage({ data: JSON.stringify({ id: sent[0].id, error: { message: "permission denied" } }) })
    await expect(pending).rejects.toThrow("permission denied")
  })
})

describe("BrowserRPCHandler training download", () => {
  test("forwards the selected packageName to the browser-owned controller", async () => {
    const sent: Array<Record<string, unknown>> = []
    const downloadTrainingWheel = vi.fn().mockResolvedValue({ status: "ok" })
    const handler: any = new BrowserRPCHandler({} as any, "ws://test", undefined, { downloadTrainingWheel })
    handler.ws = { readyState: 1, send(payload: string) { sent.push(JSON.parse(payload)) } }

    handler.handleMessage({ data: JSON.stringify({
      id: "download",
      method: "download_training_wheel",
      params: { jobId: "job-1", packageName: "nnm_vae" },
    }) })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(downloadTrainingWheel).toHaveBeenCalledWith("job-1", "nnm_vae")
    expect(sent[0]?.result).toEqual({ status: "ok" })
  })
})

describe("BrowserRPCHandler project authoring", () => {
  test("routes all four top-level requests to the shared project operations", async () => {
    const stereotype = { id: "model.custom", version: "1.0.0", path: "packages/custom" }
    const dataset = { id: "demo.tokens", version: "1.0.0", path: "datasets/tokens" }
    const authoring: ProjectAuthoringOperations = {
      createStereotype: vi.fn().mockResolvedValue(stereotype),
      deleteStereotype: vi.fn().mockResolvedValue(stereotype),
      createDataset: vi.fn().mockResolvedValue(dataset),
      deleteDataset: vi.fn().mockResolvedValue(dataset),
    }
    const diagram = { nodes: [], edges: [], packageCatalog: [] } as any
    const sent: Array<Record<string, unknown>> = []
    const handler: any = new BrowserRPCHandler(diagram, "ws://test", undefined, undefined, undefined, authoring)
    handler.ws = { readyState: 1, send(payload: string) { sent.push(JSON.parse(payload)) } }
    const stereotypeRequest = {
      id: "model.custom",
      version: "1.0.0",
      directory: "packages/custom",
      name: "Custom",
      kind: "layer",
      view: { color: "#123456", width: 120, height: 80 },
      dependencies: { "core.relu": "^0.1.0" },
      parameters: [],
    }
    const datasetRequest = {
      id: "demo.tokens",
      version: "1.0.0",
      directory: "datasets/tokens",
      name: "Tokens",
      parameters: [],
      inputs: [{ name: "tokens", shape: ["B", "T"], dtype: "int64" }],
      targets: [{ name: "next_tokens", shape: ["B", "T"], dtype: "int64" }],
      classes: { count: 2, names: ["no", "yes"] },
      dataFiles: [{ path: "train.pt", dataBase64: "AQID" }],
    }
    const calls = [
      { id: "create-stereotype", method: "create_stereotype", params: stereotypeRequest },
      { id: "delete-stereotype", method: "delete_stereotype", params: stereotype },
      { id: "create-dataset", method: "create_dataset", params: datasetRequest },
      { id: "delete-dataset", method: "delete_dataset", params: dataset },
    ]
    for (const call of calls) handler.handleMessage({ data: JSON.stringify(call) })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(authoring.createStereotype).toHaveBeenCalledWith(stereotypeRequest)
    expect(authoring.deleteStereotype).toHaveBeenCalledWith(stereotype)
    expect(authoring.createDataset).toHaveBeenCalledWith({
      ...datasetRequest,
      dataFiles: [{ path: "train.pt", bytes: new Uint8Array([1, 2, 3]) }],
    })
    expect(authoring.deleteDataset).toHaveBeenCalledWith(dataset)
    expect(sent.map((response) => response.result)).toEqual([stereotype, stereotype, dataset, dataset])
  })

  test("rejects non-canonical dataset base64 before the shared coordinator runs", async () => {
    const createDataset = vi.fn()
    const authoring = {
      createStereotype: vi.fn(),
      deleteStereotype: vi.fn(),
      createDataset,
      deleteDataset: vi.fn(),
    } as unknown as ProjectAuthoringOperations
    const sent: Array<Record<string, unknown>> = []
    const handler: any = new BrowserRPCHandler({} as any, "ws://test", undefined, undefined, undefined, authoring)
    handler.ws = { readyState: 1, send(payload: string) { sent.push(JSON.parse(payload)) } }

    handler.handleMessage({ data: JSON.stringify({
      id: "bad-dataset",
      method: "create_dataset",
      params: { id: "demo.tokens", dataFiles: [{ path: "train.pt", dataBase64: "AB==" }] },
    }) })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(createDataset).not.toHaveBeenCalled()
    expect(sent[0]?.error).toMatchObject({ message: expect.stringMatching(/canonical base64/) })
  })

  test("returns coordinator failures without reporting a successful delete", async () => {
    const authoring: ProjectAuthoringOperations = {
      createStereotype: vi.fn(),
      deleteStereotype: vi.fn().mockRejectedValue(new Error("stereotype is required by another package")),
      createDataset: vi.fn(),
      deleteDataset: vi.fn(),
    }
    const sent: Array<Record<string, unknown>> = []
    const handler: any = new BrowserRPCHandler({} as any, "ws://test", undefined, undefined, undefined, authoring)
    handler.ws = { readyState: 1, send(payload: string) { sent.push(JSON.parse(payload)) } }

    handler.handleMessage({ data: JSON.stringify({
      id: "blocked-delete",
      method: "delete_stereotype",
      params: { id: "model.custom", version: "1.0.0", path: "packages/custom" },
    }) })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(sent[0]?.result).toBeUndefined()
    expect(sent[0]?.error).toEqual({ message: "stereotype is required by another package" })
  })
})

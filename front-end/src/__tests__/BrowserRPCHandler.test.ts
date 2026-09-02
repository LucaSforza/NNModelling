import { describe, expect, test, vi } from "vitest"
import { BrowserRPCHandler } from "../sync/BrowserRPCHandler"

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

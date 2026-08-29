import { describe, expect, test } from "vitest"
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
})

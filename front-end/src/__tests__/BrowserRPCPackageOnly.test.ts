import { describe, expect, test } from "vitest"
import { BrowserRPCHandler } from "../sync/BrowserRPCHandler"

const input = {
  id: "core.input", version: "0.1.0",
  definition: { name: "Input", kind: "input", parameters: {}, view: { color: "#000000", width: 30, height: 30 } },
}
const linear = {
  id: "core.linear", version: "0.1.0",
  definition: { name: "Linear", kind: "layer", parameters: { width: { type: "integer", default: 4 } }, view: { color: "#000000", width: 140, height: 60 } },
}

function harness() {
  const sent: Array<Record<string, unknown>> = []
  const diagram: any = {
    nodes: [], edges: [], packageCatalog: [input, linear], typeResult: null,
    refreshTypes() {
      this.typeResult = { nodes: new Map(), order: [], terminals: [], complete: false }
      return this.typeResult
    },
    getNodeById(id: string) { return this.nodes.find((node: any) => node.id === id) },
    addPackageNode(identity: any, kind: string, x: number, y: number, config: any) {
      const node = { id: `${kind}-1`, type: kind === "join" ? "join" : kind === "subflow" ? "subflow" : "custom", position: { x, y }, data: { package: identity, name: config.name ?? identity.name, params: config.params ?? {} } }
      this.nodes.push(node)
      return node
    },
    updatePackageNode(id: string, _identity: unknown, _kind: unknown, config: any) {
      const node = this.getNodeById(id)
      node.data.params = config.params
    },
    getSelectedNodes: () => [], getSelectedEdges: () => [],
    selectNodes: () => undefined, clearSelection: () => undefined,
    exportToJson: () => JSON.stringify({ nodes: this.nodes, edges: this.edges }),
  }
  const handler: any = new BrowserRPCHandler(diagram, "ws://test")
  handler.ws = { readyState: 1, send(payload: string) { sent.push(JSON.parse(payload)) } }
  return { handler, diagram, sent }
}

describe("BrowserRPC package-only boundary", () => {
  test("rejects legacy create and creates exact package identity", () => {
    const { handler, diagram, sent } = harness()
    handler.handleMessage({ data: JSON.stringify({ id: "legacy", method: "create_node", params: { stereotype: "Linear" } }) })
    expect(sent[0]?.error?.message).toContain("requires package")

    handler.handleMessage({ data: JSON.stringify({ id: "package", method: "create_node", params: {
      package: { id: "core.linear", version: "0.1.0", name: "Linear", kind: "layer" },
      config: { params: { width: 8 } },
    } }) })
    expect(sent[1]?.result).toMatchObject({ package: { id: "core.linear", version: "0.1.0", name: "Linear" } })
    expect(diagram.nodes[0].data.params).toEqual({ width: 8 })
  })

  test("updates primitive parameters and exposes one type endpoint", () => {
    const { handler, diagram, sent } = harness()
    const node = diagram.addPackageNode({ id: linear.id, version: linear.version, name: "Linear" }, "layer", 0, 0, { params: { width: 4 } })
    handler.handleMessage({ data: JSON.stringify({ id: "set", method: "set_parameter", params: { nodeId: node.id, key: "width", value: 16 } }) })
    expect(sent[0]?.result).toMatchObject({ currentValue: 16 })
    expect(node.data.params).toEqual({ width: 16 })

    handler.handleMessage({ data: JSON.stringify({ id: "duplicate", method: "get_package_type_info", params: {} }) })
    expect(sent[1]?.error?.message).toContain("Unknown method")
  })

  test("rejects removed conversion RPC methods", () => {
    const { handler, sent } = harness()
    handler.handleMessage({ data: JSON.stringify({ id: "compile", method: "compile_nntree", params: {} }) })
    expect(sent[0]?.error?.message).toContain("Unknown method")
  })
})

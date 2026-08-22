/*
 * NNModelling — DSL for designing neural networks via visual node editor
 * Copyright (C) 2026  Luca Sforza
 *
 * Licensed under the GNU General Public License v3 or later.
 * Commercial licenses are available — contact Luca Sforza.
 * See the LICENSE file for details.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 */

import { describe, it, expect, vi, afterAll } from "vitest";
import { BrowserRPCHandler } from "../sync/BrowserRPCHandler";
import { Diagram } from "../Diagram.svelte";
import { stubWindow, unstubWindow } from "./helpers";
import type { Node, Edge } from "@xyflow/svelte";

stubWindow();
afterAll(() => unstubWindow());

describe("BrowserRPCHandler", () => {
  /**
   * Create a BrowserRPCHandler with a real Diagram but stub the WebSocket
   * so we can inspect outgoing RPC responses without a real connection.
   */
  function createHandler() {
    const diagram = new Diagram();
    // Reset to known state (Diagram auto-spawns an Input node, which we clear)
    diagram.nodes = [];
    diagram.edges = [];
    diagram.refreshTypes();

    const handler = new BrowserRPCHandler(diagram, "ws://localhost:0");

    // Stub the internal WebSocket with a mock
    const mockSend = vi.fn();
    (handler as any).ws = {
      send: mockSend,
      readyState: 1, // WebSocket.OPEN
      close: vi.fn(),
    };

    return { handler, diagram, mockSend };
  }

  // ── Dispatch to correct method ──────────────────────────────────────

  it("dispatches get_graph and returns nodes and edges", () => {
    const { handler, diagram, mockSend } = createHandler();

    // Attach some test data
    const testNode = { id: "n1", type: "custom", position: { x: 0, y: 0 }, data: {} } as Node;
    const testEdge = { id: "e1", source: "n1", target: "n2" } as Edge;
    diagram.nodes = [testNode];
    diagram.edges = [testEdge];

    // Simulate an incoming RPC request via WebSocket
    (handler as any).handleMessage({
      data: JSON.stringify({ id: "req-1", method: "get_graph" }),
    });

    expect(mockSend).toHaveBeenCalledTimes(1);

    const response = JSON.parse(mockSend.mock.calls[0][0]);
    expect(response.id).toBe("req-1");
    expect(response.result).toBeDefined();
    expect(response.result.nodes).toHaveLength(1);
    expect(response.result.nodes[0].id).toBe("n1");
    expect(response.result.edges).toHaveLength(1);
    expect(response.result.edges[0].id).toBe("e1");
  });

  it("sends RPC responses without requiring a global WebSocket constructor", () => {
    const { handler, mockSend } = createHandler();
    vi.stubGlobal("WebSocket", undefined);

    try {
      (handler as any).handleMessage({
        data: JSON.stringify({ id: "node20-response", method: "ping" }),
      });
      expect(mockSend).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("dispatches get_node and returns the matching node", () => {
    const { handler, diagram, mockSend } = createHandler();

    const testNode = { id: "n42", type: "custom", position: { x: 10, y: 20 }, data: { name: "TestNode" } } as Node;
    diagram.nodes = [testNode];

    (handler as any).handleMessage({
      data: JSON.stringify({ id: "req-2", method: "get_node", params: { nodeId: "n42" } }),
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const response = JSON.parse(mockSend.mock.calls[0][0]);
    expect(response.id).toBe("req-2");
    expect(response.result).toBeDefined();
    expect(response.result.id).toBe("n42");
  });

  it("exposes JSON-safe package type information", () => {
    const { handler, diagram, mockSend } = createHandler();
    const testNode = { id: "package-node", type: "custom", position: { x: 0, y: 0 }, data: {} } as Node;
    diagram.nodes = [testNode];
    diagram.packageTypeResult = {
      complete: true,
      terminals: [testNode.id],
      order: [testNode.id],
      nodes: new Map([[testNode.id, {
        status: "success",
        output: { shape: ["B", 16], dtype: "float32" },
      }]]),
    };

    (handler as any).handleMessage({
      data: JSON.stringify({ id: "package-types", method: "get_package_type_info", params: { nodeId: testNode.id } }),
    });
    expect(JSON.parse(mockSend.mock.calls[0][0]).result).toEqual({
      status: "success",
      output: { shape: ["B", 16], dtype: "float32" },
    });

    mockSend.mockClear();
    (handler as any).handleMessage({ data: JSON.stringify({ id: "graph", method: "get_graph" }) });
    const graph = JSON.parse(mockSend.mock.calls[0][0]).result;
    expect(graph.packageTypeInfo.nodes[testNode.id].output.shape).toEqual(["B", 16]);
  });

  it("recomputes types after RPC mutations and exposes JSON-safe type information", () => {
    const { handler, diagram, mockSend } = createHandler();

    const dispatch = (id: string, method: string, params: Record<string, unknown> = {}) => {
      mockSend.mockClear();
      (handler as any).handleMessage({
        data: JSON.stringify({ id, method, params }),
      });
      expect(mockSend).toHaveBeenCalledTimes(1);
      return JSON.parse(mockSend.mock.calls[0][0]);
    };

    const inputResponse = dispatch("create-input", "create_node", {
      stereotype: "Input",
      config: { params: { out_features: "784" } },
    });
    const inputId = inputResponse.result.nodeId as string;

    const linearResponse = dispatch("create-linear", "create_node", {
      stereotype: "Linear",
      config: { params: { in_features: "784", out_features: "10" } },
    });
    const linearId = linearResponse.result.nodeId as string;

    dispatch("connect", "connect_nodes", { source: inputId, target: linearId });

    // The graph-change notification is synchronous, so the hover state is
    // ready as soon as the remote mutation completes.
    const liveAnnotation = diagram.typeResult?.annotations.get(linearId);
    expect(liveAnnotation?.outputType.shape).toEqual([
      { kind: "symbolic", name: "B" },
      { kind: "const", value: 10 },
    ]);

    const typeResponse = dispatch("types", "get_type_info", { nodeId: linearId });
    expect(typeResponse.result.annotation.nodeId).toBe(linearId);
    expect(typeResponse.result.annotation.outputType.shape).toEqual([
      { kind: "symbolic", name: "B" },
      { kind: "const", value: 10 },
    ]);
    expect(typeResponse.result.errors).toEqual([]);

    const graphResponse = dispatch("graph", "get_graph");
    expect(graphResponse.result.typeInfo.ok).toBe(true);
    expect(graphResponse.result.typeInfo.annotations[linearId].outputType.shape[1]).toEqual({
      kind: "const",
      value: 10,
    });

    const nodeResponse = dispatch("node", "get_node", { nodeId: linearId });
    expect(nodeResponse.result.typeInfo.annotation.outputType.shape[1]).toEqual({
      kind: "const",
      value: 10,
    });
  });

  it("preserves parameter presentation metadata when values are updated", () => {
    const { handler, diagram, mockSend } = createHandler();
    const linear = diagram.getStereotype("Linear")!;
    diagram.addModule(linear, 0, 0, {
      params: { in_features: "784", out_features: "10" },
    });
    const nodeId = diagram.nodes[0].id;

    // Reproduce a node damaged by the old RPC implementation.
    diagram.nodes[0].data.params = {
      in_features: { value: "784" },
      out_features: { value: "10" },
    };

    const dispatch = (id: string, method: string, params: Record<string, unknown>) => {
      mockSend.mockClear();
      (handler as any).handleMessage({
        data: JSON.stringify({ id, method, params }),
      });
      expect(mockSend).toHaveBeenCalledTimes(1);
    };

    dispatch("set-param", "set_parameter", {
      nodeId,
      key: "in_features",
      value: "128",
    });
    dispatch("update-params", "update_parameters", {
      nodeId,
      params: { out_features: "64" },
    });

    expect(diagram.nodes[0].data.params).toMatchObject({
      in_features: { value: "128", position: "top" },
      out_features: { value: "64", position: "bottom" },
    });
  });

  it("creates a Repeat stereotype as a subflow container through MCP", () => {
    const { handler, diagram, mockSend } = createHandler();

    (handler as any).handleMessage({
      data: JSON.stringify({
        id: "create-repeat-subflow",
        method: "create_node",
        params: {
          stereotype: "Repeat",
          position: { x: 100, y: 200 },
          config: { params: { iterations: "2" } },
        },
      }),
    });

    const response = JSON.parse(mockSend.mock.calls[0][0]);
    expect(response.error).toBeUndefined();
    const repeat = diagram.getNodeById(response.result.nodeId);
    expect(repeat?.type).toBe("subflow");
    expect(repeat?.data.stereotype).toBe("Repeat");
    expect(repeat?.data.params).toMatchObject({
      iterations: { value: "2" },
    });
  });

  it("validates a Repeat subflow's internal Input without counting it as a second graph Input", () => {
    const { handler, diagram, mockSend } = createHandler();
    diagram.nodes = [
      {
        id: "top-input",
        type: "custom",
        position: { x: 0, y: 0 },
        data: { stereotype: "Input", name: "Input", isInput: true },
      },
      {
        id: "repeat",
        type: "subflow",
        position: { x: 100, y: 0 },
        data: {
          stereotype: "Repeat",
          name: "Repeat",
          params: { iterations: { value: "2" } },
        },
      },
      {
        id: "repeat-input",
        type: "custom",
        parentId: "repeat",
        position: { x: 0, y: 0 },
        data: { stereotype: "Input", name: "Repeat input", isInput: true },
      },
      {
        id: "repeat-relu",
        type: "custom",
        parentId: "repeat",
        position: { x: 100, y: 0 },
        data: { stereotype: "ReLU", name: "Repeat ReLU" },
      },
      {
        id: "loss",
        type: "custom",
        position: { x: 300, y: 0 },
        data: { stereotype: "CrossEntropyLoss", name: "Loss", isLoss: true },
      },
    ] as Node[];
    diagram.edges = [
      { id: "e1", source: "top-input", target: "repeat" },
      { id: "e2", source: "repeat", target: "loss" },
      { id: "e3", source: "repeat-input", target: "repeat-relu" },
    ] as Edge[];

    (handler as any).handleMessage({
      data: JSON.stringify({ id: "validate-repeat", method: "validate_graph" }),
    });

    const response = JSON.parse(mockSend.mock.calls[0][0]);
    expect(response.result).toEqual({ valid: true, errors: [], warnings: [] });
  });

  it("returns an error when type information is requested for an unknown node", () => {
    const { handler, mockSend } = createHandler();

    (handler as any).handleMessage({
      data: JSON.stringify({
        id: "req-missing-type",
        method: "get_type_info",
        params: { nodeId: "ghost" },
      }),
    });

    const response = JSON.parse(mockSend.mock.calls[0][0]);
    expect(response.error.message).toContain("Node not found");
  });

  it("blocks MCP NNTree compilation when the graph has hard type errors", () => {
    const { handler, diagram, mockSend } = createHandler();
    const input = diagram.getStereotype("Input")!;
    const linear = diagram.getStereotype("Linear")!;
    diagram.addModule(input, 0, 0, {
      params: { out_features: { value: "784" } },
    });
    diagram.addModule(linear, 100, 0, {
      params: {
        in_features: { value: "128" },
        out_features: { value: "10" },
      },
    });
    diagram.addEdge(diagram.nodes[0].id, diagram.nodes[1].id);
    mockSend.mockClear();

    (handler as any).handleMessage({
      data: JSON.stringify({ id: "compile-invalid", method: "compile_nntree" }),
    });

    const response = JSON.parse(mockSend.mock.calls[0][0]);
    expect(response.error.message).toMatch(/compilation blocked.*type error/i);
  });

  it("dispatches ping and returns status ok", () => {
    const { handler, mockSend } = createHandler();

    (handler as any).handleMessage({
      data: JSON.stringify({ id: "req-ping", method: "ping" }),
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const response = JSON.parse(mockSend.mock.calls[0][0]);
    expect(response.id).toBe("req-ping");
    expect(response.result).toBeDefined();
    expect(response.result.status).toBe("ok");
  });

  // ── Unknown method returns error ────────────────────────────────────

  it("returns error for unknown method", () => {
    const { handler, mockSend } = createHandler();

    (handler as any).handleMessage({
      data: JSON.stringify({ id: "req-unknown", method: "nonexistent" }),
    });

    expect(mockSend).toHaveBeenCalledTimes(1);

    const response = JSON.parse(mockSend.mock.calls[0][0]);
    expect(response.id).toBe("req-unknown");
    expect(response.error).toBeDefined();
    expect(response.error.message).toContain("Unknown method");
  });

  it("returns error for unknown method with params", () => {
    const { handler, mockSend } = createHandler();

    (handler as any).handleMessage({
      data: JSON.stringify({ id: "req-99", method: "fly_to_moon", params: { fuel: "hydrogen" } }),
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const response = JSON.parse(mockSend.mock.calls[0][0]);
    expect(response.id).toBe("req-99");
    expect(response.error).toBeDefined();
    expect(response.error.message).toContain("Unknown method");
  });

  // ── Error in handler returns error response ─────────────────────────

  it("returns error when handler throws (missing required parameter)", () => {
    const { handler, mockSend } = createHandler();

    // delete_nodes without nodeIds param — handler throws before mutating
    (handler as any).handleMessage({
      data: JSON.stringify({ id: "req-3", method: "delete_nodes", params: {} }),
    });

    expect(mockSend).toHaveBeenCalledTimes(1);

    const response = JSON.parse(mockSend.mock.calls[0][0]);
    expect(response.id).toBe("req-3");
    expect(response.error).toBeDefined();
    expect(response.error.message).toBe("nodeIds must be an array");
  });

  it("returns error when get_node is called without nodeId", () => {
    const { handler, mockSend } = createHandler();

    (handler as any).handleMessage({
      data: JSON.stringify({ id: "req-4", method: "get_node", params: {} }),
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const response = JSON.parse(mockSend.mock.calls[0][0]);
    expect(response.id).toBe("req-4");
    expect(response.error).toBeDefined();
    expect(response.error.message).toContain("Missing required parameter");
  });

  it("returns error when get_node targets nonexistent node", () => {
    const { handler, mockSend } = createHandler();

    (handler as any).handleMessage({
      data: JSON.stringify({ id: "req-5", method: "get_node", params: { nodeId: "ghost" } }),
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const response = JSON.parse(mockSend.mock.calls[0][0]);
    expect(response.id).toBe("req-5");
    expect(response.error).toBeDefined();
    expect(response.error.message).toContain("Node not found");
  });

  // ── Edge cases: malformed messages ──────────────────────────────────

  it("ignores invalid JSON in messages", () => {
    const { handler, mockSend } = createHandler();

    (handler as any).handleMessage({
      data: "not valid json",
    });

    // No response should be sent for unparseable messages
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("ignores malformed RPC requests (missing id and method)", () => {
    const { handler, mockSend } = createHandler();

    (handler as any).handleMessage({
      data: JSON.stringify({ foo: "bar" }),
    });

    expect(mockSend).not.toHaveBeenCalled();
  });

  // ── create_node with params ──────────────────────────────────────────
  // BUG: create_node via RPC passes params as Record<string, string>,
  // but addModule uses all-or-nothing — if any user params exist,
  // stereotype defaults are discarded.

  it("BUG: create_node with partial params should preserve stereotype defaults", () => {
    const { handler, diagram, mockSend } = createHandler();

    // Simulate RPC: create a Linear node with only in_features and out_features
    (handler as any).handleMessage({
      data: JSON.stringify({
        id: "req-create-linear",
        method: "create_node",
        params: {
          stereotype: "Linear",
          position: { x: 100, y: 200 },
          config: {
            params: { in_features: "128", out_features: "64" },
          },
        },
      }),
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const response = JSON.parse(mockSend.mock.calls[0][0]);
    expect(response.id).toBe("req-create-linear");
    expect(response.result).toBeDefined();
    expect(response.result.nodeId).toBeDefined();
    expect(response.result.stereotype).toBe("Linear");

    // Verify the created node has params
    const node = diagram.getNodeById(response.result.nodeId);
    expect(node).toBeDefined();

    const params = (node!.data.params as Record<string, { value: string }>) ?? {};

    // User values should be applied
    expect(params.in_features).toBeDefined();
    expect(params.in_features?.value).toBe("128");
    expect(params.out_features?.value).toBe("64");

    // BUG: Stereotype defaults (bias="True", device="None", dtype="None")
    // are currently LOST because addModule uses all-or-nothing params.
    // These assertions should pass after the fix:
    expect(params.bias).toBeDefined();
    expect(params.bias?.value).toBe("True");
    expect(params.device).toBeDefined();
    expect(params.device?.value).toBe("None");
    expect(params.dtype).toBeDefined();
    expect(params.dtype?.value).toBe("None");
  });

  // ── fit_view / center_view stubs ─────────────────────────────────────
  // BUG: handleFitView and handleCenterView are no-ops.
  // They return { success: true } but don't call any viewport API.
  // After the fix, BrowserRPCHandler should accept viewport callbacks
  // and call them when these RPC methods are invoked.

  it("BUG: fit_view handler exists but is a no-op (should call viewport callback)", () => {
    // NOTE: Currently BrowserRPCHandler does NOT accept viewport callbacks.
    // This test documents the desired behavior after the fix.
    // For now, it only verifies the handler doesn't throw and returns.
    const { handler, mockSend } = createHandler();

    (handler as any).handleMessage({
      data: JSON.stringify({
        id: "req-fit",
        method: "fit_view",
        params: {},
      }),
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const response = JSON.parse(mockSend.mock.calls[0][0]);
    expect(response.id).toBe("req-fit");
    expect(response.result).toEqual({ success: true, note: "fit_view executed" });
    // NOTE: This is a no-op — no actual viewport adjustment happens.
    // After the fix, a viewport callback should be invoked.
  });

  it("BUG: center_view handler exists but is a no-op (should call viewport callback)", () => {
    const { handler, mockSend } = createHandler();

    (handler as any).handleMessage({
      data: JSON.stringify({
        id: "req-center",
        method: "center_view",
        params: { x: 300, y: 400, zoom: 1.5 },
      }),
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const response = JSON.parse(mockSend.mock.calls[0][0]);
    expect(response.id).toBe("req-center");
    expect(response.result).toEqual({ success: true, note: "center_view executed" });
    // NOTE: This is a no-op — x, y, zoom are ignored.
  });

  // ── Viewport injection tests (Bug 2 fix verification) ───────────────

  it("fit_view calls fitView callback when viewport is provided", () => {
    const diagram = new Diagram();
    diagram.nodes = [];
    diagram.edges = [];

    const fitViewMock = vi.fn();
    const syncClient = new BrowserRPCHandler(diagram, "ws://localhost:0", {
      fitView: fitViewMock,
      setCenter: vi.fn(),
    });

    // Stub WebSocket to capture responses
    const mockSend = vi.fn();
    (syncClient as any).ws = { send: mockSend, readyState: 1 /* WebSocket.OPEN */, close: vi.fn() };

    (syncClient as any).handleMessage({
      data: JSON.stringify({ id: "req-fit-vp", method: "fit_view", params: {} }),
    });

    expect(fitViewMock).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
    const response = JSON.parse(mockSend.mock.calls[0][0]);
    expect(response.result).toEqual({ success: true });
  });

  it("fit_view with nodeIds passes them to fitView", () => {
    const diagram = new Diagram();
    diagram.nodes = [];
    diagram.edges = [];

    const fitViewMock = vi.fn();
    const syncClient = new BrowserRPCHandler(diagram, "ws://localhost:0", {
      fitView: fitViewMock,
      setCenter: vi.fn(),
    });

    const mockSend = vi.fn();
    (syncClient as any).ws = { send: mockSend, readyState: 1 /* WebSocket.OPEN */, close: vi.fn() };

    (syncClient as any).handleMessage({
      data: JSON.stringify({
        id: "req-fit-ids",
        method: "fit_view",
        params: { nodeIds: ["n1", "n2"] },
      }),
    });

    expect(fitViewMock).toHaveBeenCalledTimes(1);
    // Should pass node objects to fitView
    expect(fitViewMock).toHaveBeenCalledWith({ nodes: [{ id: "n1" }, { id: "n2" }] });
  });

  it("center_view calls setCenter callback with x,y,zoom when viewport is provided", () => {
    const diagram = new Diagram();
    diagram.nodes = [];
    diagram.edges = [];

    const setCenterMock = vi.fn();
    const syncClient = new BrowserRPCHandler(diagram, "ws://localhost:0", {
      fitView: vi.fn(),
      setCenter: setCenterMock,
    });

    const mockSend = vi.fn();
    (syncClient as any).ws = { send: mockSend, readyState: 1 /* WebSocket.OPEN */, close: vi.fn() };

    (syncClient as any).handleMessage({
      data: JSON.stringify({
        id: "req-center-vp",
        method: "center_view",
        params: { x: 300, y: 400, zoom: 1.5 },
      }),
    });

    expect(setCenterMock).toHaveBeenCalledTimes(1);
    expect(setCenterMock).toHaveBeenCalledWith(300, 400, { zoom: 1.5 });
    expect(mockSend).toHaveBeenCalledTimes(1);
    const response = JSON.parse(mockSend.mock.calls[0][0]);
    expect(response.result).toEqual({ success: true });
  });

  it("viewport handlers don't throw when viewport is undefined (graceful degradation)", () => {
    const { handler, mockSend } = createHandler();
    // createHandler() doesn't provide viewport — should not throw

    expect(() => {
      (handler as any).handleMessage({
        data: JSON.stringify({ id: "r1", method: "fit_view", params: {} }),
      });
    }).not.toThrow();

    expect(() => {
      (handler as any).handleMessage({
        data: JSON.stringify({ id: "r2", method: "center_view", params: { x: 0, y: 0, zoom: 1 } }),
      });
    }).not.toThrow();
  });
});

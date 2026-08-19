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
import { Diagram } from "../Diagram.svelte";
import { BrowserRPCHandler } from "../sync/BrowserRPCHandler";
import { edge, node, stubWindow, unstubWindow } from "./helpers";
import { getInputArityBounds } from "../core/types";

stubWindow();
afterAll(() => unstubWindow());

// ---------------------------------------------------------------------------
// Graph-change subscription contract (replaces the generic EventBus)
// ---------------------------------------------------------------------------
// DiagramCore.onGraphChanged() is the single, dedicated graph-change signal:
//   - synchronous delivery (one notification per successful public mutation);
//   - no notification for rejected connections or no-op operations;
//   - undo/redo and import notify exactly once per successful public op;
//   - unsubscribe is safe (also from inside a handler).
// ---------------------------------------------------------------------------

function getLinearStereotype(diagram: Diagram) {
  const s = diagram.getStereotype("Linear");
  if (!s) throw new Error("Linear stereotype not found");
  return s;
}

describe("DiagramCore graph-change subscription", () => {
  it("derives Join handle bounds from every ordered InputGroup", () => {
    expect(getInputArityBounds({
      inputs: [
        { lower: 1, upper: 1 },
        { lower: 2, upper: 4 },
      ],
    })).toEqual({ min: 3, max: 5 });
    expect(getInputArityBounds({
      inputs: [
        { lower: 2, upper: null },
        { lower: 1, upper: 1 },
      ],
    })).toEqual({ min: 3, max: null });
  });

  it("uses the bundled Join signatures for fixed and variadic handle bounds", () => {
    const diagram = new Diagram();
    const arityOf = (name: string) => getInputArityBounds(
      diagram.getStereotype(name)?.typeSignature,
    );

    expect(arityOf("Addition")).toEqual({ min: 2, max: null });
    expect(arityOf("Concat")).toEqual({ min: 2, max: null });
    expect(arityOf("MatMul")).toEqual({ min: 2, max: 2 });
    expect(arityOf("ScaledDotProduct")).toEqual({ min: 2, max: 2 });
    expect(arityOf("Einsum")).toEqual({ min: 1, max: null });
  });

  it("creates joins at the signature lower bound and preserves saved arity", () => {
    const diagram = new Diagram();
    const addition = diagram.getStereotype("Addition")!;
    const matMul = diagram.getStereotype("MatMul")!;

    diagram.addJoinNode(addition, 0, 0);
    diagram.addJoinNode(matMul, 100, 0, { inputsCount: 1 });

    expect(diagram.nodes.filter((node) => node.type === "join").map((node) => node.data.inputsCount)).toEqual([2, 1]);
  });

  it("preserves a duplicated join's saved arity through undo and redo", () => {
    const diagram = new Diagram();
    const addition = diagram.getStereotype("Addition")!;
    diagram.addJoinNode(addition, 0, 0, { inputsCount: 3 });
    const original = diagram.nodes.find((node) => node.type === "join")!;

    const [{ newId }] = diagram.duplicateNodes([original.id]);
    expect(diagram.getNodeById(newId)?.data.inputsCount).toBe(3);

    expect(diagram.undo()).toBe(true);
    expect(diagram.getNodeById(newId)).toBeUndefined();
    expect(diagram.redo()).toBe(true);
    expect(diagram.getNodeById(newId)?.data.inputsCount).toBe(3);
  });

  it("notifies synchronously when a public mutation succeeds", () => {
    const diagram = new Diagram();
    let calls = 0;
    diagram.onGraphChanged(() => calls++);

    diagram.addModule(getLinearStereotype(diagram), 100, 100);

    // Synchronous: the handler has already run when addModule returns.
    expect(calls).toBe(1);
  });

  it("notifies once for accepted automatic layout and zero times for its no-op", () => {
    const diagram = new Diagram();
    diagram.addModule(getLinearStereotype(diagram), 100, 100);
    let calls = 0;
    diagram.onGraphChanged(() => calls++);

    expect(diagram.autoLayout("horizontal")).toBe(true);
    expect(calls).toBe(1);

    expect(diagram.autoLayout("horizontal")).toBe(false);
    expect(calls).toBe(1);
  });

  it("notifies once for an accepted route update and never for route no-ops", () => {
    const diagram = new Diagram();
    const linear = getLinearStereotype(diagram);
    diagram.addModule(linear, 100, 100);
    diagram.addModule(linear, 200, 200);
    const [source, target] = diagram.nodes.filter((node) => !node.data.isInput);
    const edge = diagram.addEdge(source.id, target.id);

    let calls = 0;
    diagram.onGraphChanged(() => calls++);
    const undoLength = (diagram as any)._undoStack.length;

    expect(diagram.updateEdgeRoute(edge.id, [{ x: 20, y: 40 }])).toBe(true);
    expect(calls).toBe(1);
    expect((diagram as any)._undoStack).toHaveLength(undoLength + 1);

    expect(diagram.updateEdgeRoute(edge.id, [{ x: 20, y: 40 }])).toBe(false);
    expect(diagram.updateEdgeRoute("unknown", [{ x: 20, y: 40 }])).toBe(false);
    expect(calls).toBe(1);
    expect((diagram as any)._undoStack).toHaveLength(undoLength + 1);
  });

  it("does not notify when an RPC connection is rejected", () => {
    const diagram = new Diagram();
    let calls = 0;
    diagram.onGraphChanged(() => calls++);

    // Two identical modules: connect n1 -> n2 is valid, n2 -> n1 would create
    // a directed cycle and must be rejected without any notification.
    diagram.addModule(getLinearStereotype(diagram), 100, 100);
    diagram.addModule(getLinearStereotype(diagram), 200, 200);
    const [n1, n2] = diagram.nodes.filter((n) => !n.data.isInput);
    diagram.addEdge(n1.id, n2.id);
    expect(calls).toBe(3); // 2 addModule + 1 addEdge

    expect(() => diagram.addEdge(n2.id, n1.id)).toThrow(/cycle/i);
    expect(calls).toBe(3); // rejected connection did not notify
  });

  it("does not notify on no-op undo/redo or invalid import", () => {
    const diagram = new Diagram();
    let calls = 0;
    diagram.onGraphChanged(() => calls++);

    // Undo/redo with empty stacks return false without restoring a snapshot.
    expect(diagram.undo()).toBe(false);
    expect(diagram.redo()).toBe(false);
    expect(calls).toBe(0);

    // Invalid JSON must fail without any notification.
    expect(diagram.importFromJson("not json")).toBe(false);
    expect(calls).toBe(0);
  });

  it("does not notify or capture undo for rejected containment mutations", () => {
    const diagram = new Diagram();
    diagram.nodes = [
      node("top-a", "Linear", "top-a"),
      node("top-b", "Linear", "top-b"),
      node("container", "", "container", {}, { type: "subflow" }),
      node("child", "Linear", "child", {}, { parentId: "container" }),
    ];
    diagram.edges = [edge("top-edge", "top-a", "top-b")];
    const graphBefore = diagram.exportToJson();
    const undoLengthBefore = (diagram as any)._undoStack.length;
    let calls = 0;
    diagram.onGraphChanged(() => calls++);

    expect(() => diagram.addEdge("child", "top-a")).toThrow(/containment scope/i);
    expect(() => diagram.reconnectEdge("top-edge", undefined, "child")).toThrow(/containment scope/i);
    expect(diagram.importFromJson(JSON.stringify({
      nodes: diagram.nodes,
      edges: [edge("bad-import", "top-a", "child")],
    }))).toBe(false);

    expect(diagram.exportToJson()).toBe(graphBefore);
    expect((diagram as any)._undoStack.length).toBe(undoLengthBefore);
    expect(calls).toBe(0);
  });

  it("notifies exactly once for each representative public mutation", () => {
    const diagram = new Diagram();
    let calls = 0;
    diagram.onGraphChanged(() => calls++);

    const stereo = getLinearStereotype(diagram);
    const input = diagram.nodes.find((n) => n.data.isInput)!;

    diagram.addModule(stereo, 100, 100);
    const linear = diagram.nodes.find((n) => !n.data.isInput)!;
    diagram.updateModule(linear.id, { color: "#ff0000" });
    diagram.addEdge(input.id, linear.id);
    const edgeId = diagram.edges[0].id;
    // Real reconnect: change the target handle (an equivalent reconnect is a
    // no-op and must not notify).
    diagram.reconnectEdge(edgeId, undefined, undefined, undefined, "in-2");
    diagram.removeEdge(input.id, linear.id);
    diagram.moveNode(linear.id, 300, 300);
    diagram.moveNodes([{ id: linear.id, x: 400, y: 400 }]);
    diagram.deleteNode(linear.id);
    diagram.addSubGraph(50, 50);
    const subflow = diagram.nodes.find((n) => n.type === "subflow")!;
    diagram.toggleSubflow(subflow.id, true);

    // 1 addModule + 1 update + 1 addEdge + 1 reconnect + 1 removeEdge
    // + 1 moveNode + 1 moveNodes + 1 deleteNode + 1 addSubGraph + 1 toggle
    expect(calls).toBe(10);
  });

  it("notifies once for import success and once per undo/redo", () => {
    const diagram = new Diagram();
    let calls = 0;
    diagram.onGraphChanged(() => calls++);

    diagram.addModule(getLinearStereotype(diagram), 100, 100);
    expect(calls).toBe(1);

    expect(diagram.undo()).toBe(true);
    expect(calls).toBe(2); // restoreSnapshot

    expect(diagram.redo()).toBe(true);
    expect(calls).toBe(3); // restoreSnapshot

    const json = JSON.stringify({
      nodes: [{ id: "a", type: "custom", position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    });
    expect(diagram.importFromJson(json)).toBe(true);
    expect(calls).toBe(4); // import
  });

  it("does not notify for selection changes", () => {
    const diagram = new Diagram();
    let calls = 0;
    diagram.onGraphChanged(() => calls++);

    const ids = diagram.nodes.map((n) => n.id);
    diagram.selectNodes(ids);
    diagram.clearSelection();

    // Selection is view state, not a graph change.
    expect(calls).toBe(0);
  });

  it("unsubscribes safely (also from inside a handler)", () => {
    const diagram = new Diagram();
    let calls = 0;
    const unsubscribe = diagram.onGraphChanged(() => calls++);

    diagram.addModule(getLinearStereotype(diagram), 100, 100);
    expect(calls).toBe(1);

    unsubscribe();
    diagram.addModule(getLinearStereotype(diagram), 200, 200);
    expect(calls).toBe(1);

    // Idempotent unsubscribe.
    unsubscribe();
    diagram.addModule(getLinearStereotype(diagram), 300, 300);
    expect(calls).toBe(1);

    // Unsubscribing from inside a handler must not throw, and the handler
    // that removes itself must not run again.
    const diagram2 = new Diagram();
    let selfCalls = 0;
    const unsubSelf = diagram2.onGraphChanged(() => {
      selfCalls++;
      unsubSelf();
    });
    let otherCalls = 0;
    diagram2.onGraphChanged(() => otherCalls++);
    diagram2.addModule(getLinearStereotype(diagram2), 100, 100);
    expect(selfCalls).toBe(1); // removed during the first notification
    expect(otherCalls).toBe(1); // snapshot iteration still reaches peers
    diagram2.addModule(getLinearStereotype(diagram2), 200, 200);
    expect(selfCalls).toBe(1); // no further calls after self-unsubscribe
    expect(otherCalls).toBe(2);
  });

  it("refreshes typeResult synchronously during an RPC mutation", () => {
    // Regression for the "immediate BrowserRPC type result" invariant: a
    // remote mutation must refresh typeResult before the handler returns.
    const { diagram, dispatch } = createRpcHandler();

    const createInput = dispatch("create-input", "create_node", {
      stereotype: "Input",
      config: { params: { out_features: "784" } },
    });
    const inputId = createInput.result.nodeId;
    const createLinear = dispatch("create-linear", "create_node", {
      stereotype: "Linear",
      config: { params: { in_features: "784", out_features: "10" } },
    });
    const linearId = createLinear.result.nodeId;

    dispatch("connect", "connect_nodes", {
      source: inputId,
      target: linearId,
    });

    // Synchronous subscription: the annotation is available immediately.
    const annotation = diagram.typeResult?.annotations.get(linearId);
    expect(annotation?.outputType.shape).toEqual([
      { kind: "symbolic", name: "B" },
      { kind: "const", value: 10 },
    ]);
  });

  it("reset_diagram reassigns arrays, notifies once and refreshes types", () => {
    const { diagram, dispatch } = createRpcHandler();

    // Populate the diagram, then subscribe AFTER the setup mutations.
    dispatch("create-input", "create_node", {
      stereotype: "Input",
      config: { params: { out_features: "784" } },
    });
    dispatch("create-linear", "create_node", {
      stereotype: "Linear",
      config: { params: { in_features: "784", out_features: "10" } },
    });
    expect(diagram.nodes.length).toBe(2);

    let calls = 0;
    diagram.onGraphChanged(() => calls++);
    const nodesBefore = diagram.nodes;
    const edgesBefore = diagram.edges;

    const response = dispatch("reset", "reset_diagram");

    // Exactly one notification, arrays reassigned (fresh references), and the
    // type result is already empty before the handler returns.
    expect(calls).toBe(1);
    expect(response.result.success).toBe(true);
    expect(diagram.nodes).toEqual([]);
    expect(diagram.edges).toEqual([]);
    expect(diagram.nodes).not.toBe(nodesBefore);
    expect(diagram.edges).not.toBe(edgesBefore);
    expect(diagram.typeResult?.annotations.size ?? 0).toBe(0);
    expect(diagram.typeResult?.errors ?? []).toEqual([]);

    // Reset captures exactly one undo snapshot: one undo restores the graph.
    expect(diagram.undo()).toBe(true);
    expect(diagram.nodes.length).toBe(2);
    expect(calls).toBe(2); // restoreSnapshot notified once
  });

  it("reset on an empty diagram is a no-op (zero undo/notify)", () => {
    const diagram = new Diagram();
    diagram.nodes = [];
    diagram.edges = [];
    diagram.refreshTypes();

    let calls = 0;
    diagram.onGraphChanged(() => calls++);

    diagram.reset();
    expect(calls).toBe(0);
    expect((diagram as any)._undoStack.length).toBe(0);
    expect(diagram.nodes).toEqual([]);
    expect(diagram.edges).toEqual([]);
  });

  it("addSubGraph with label creates the subflow in one atomic operation", () => {
    const diagram = new Diagram();
    let calls = 0;
    diagram.onGraphChanged(() => calls++);

    const subflow = diagram.addSubGraph(100, 100, "Encoder");

    expect(calls).toBe(1);
    expect(subflow.type).toBe("subflow");
    expect(subflow.data.name).toBe("Encoder");
    expect(subflow.data.label).toBe("Encoder");

    // Exactly one undo snapshot: a single undo removes the subflow.
    expect(diagram.undo()).toBe(true);
    expect(diagram.getNodeById(subflow.id)).toBeUndefined();
    expect(calls).toBe(2);
  });

  it("updates a subflow after assigning its stereotype parameters", () => {
    const diagram = new Diagram();
    const subflow = diagram.addSubGraph(100, 100, "Encoder");

    // New subflows have no params until the sidebar assigns a Subflow
    // stereotype. Updating those parameters must not attempt to JSON-parse an
    // absent previous params object.
    expect(() => diagram.updateModule(subflow.id, {
      stereotype: "Repeat",
      params: { iterations: { value: "2" } },
    })).not.toThrow();

    expect(diagram.getNodeById(subflow.id)?.data.params).toEqual({
      iterations: { value: "2" },
    });
  });

  it("duplicateNodes is one atomic operation with exact one notify and undo", () => {
    const diagram = new Diagram();
    const linear = getLinearStereotype(diagram);
    const input = diagram.nodes.find((n) => n.data.isInput)!;

    diagram.addModule(linear, 100, 100);
    const nodeA = diagram.nodes.find((n) => !n.data.isInput)!;
    diagram.addModule(linear, 200, 200);
    const nodeB = diagram.nodes.find((n) => !n.data.isInput && n.id !== nodeA.id)!;
    diagram.addEdge(nodeA.id, nodeB.id);

    let calls = 0;
    diagram.onGraphChanged(() => calls++);
    const nodesBefore = diagram.nodes.length;
    const edgesBefore = diagram.edges.length;

    const mapping = diagram.duplicateNodes([nodeA.id, nodeB.id], { x: 10, y: 10 });

    expect(calls).toBe(1); // exactly one notification
    expect(mapping).toHaveLength(2);
    expect(diagram.nodes.length).toBe(nodesBefore + 2);
    expect(diagram.edges.length).toBe(edgesBefore + 1); // internal edge copied

    // Exactly one undo snapshot restores the pre-duplicate state.
    expect(diagram.undo()).toBe(true);
    expect(diagram.nodes.length).toBe(nodesBefore);
    expect(diagram.edges.length).toBe(edgesBefore);
    expect(calls).toBe(2);
  });

  it("duplicates join endpoints using the returned real node IDs", () => {
    const diagram = new Diagram();
    const linear = getLinearStereotype(diagram);
    const addition = diagram.getStereotype("Addition");
    if (!addition) throw new Error("Addition stereotype not found");

    diagram.addModule(linear, 100, 100);
    const source = diagram.nodes.find((n) => !n.data.isInput)!;
    diagram.addJoinNode(addition, 200, 100);
    const join = diagram.nodes.find((n) => n.type === "join")!;
    diagram.addEdge(source.id, join.id, "out", "in-0");

    const mapping = diagram.duplicateNodes([source.id, join.id]);
    const copiedSourceId = mapping.find((entry) => entry.originalId === source.id)!.newId;
    const copiedJoinId = mapping.find((entry) => entry.originalId === join.id)!.newId;

    expect(diagram.getNodeById(copiedSourceId)).toBeDefined();
    expect(diagram.getNodeById(copiedJoinId)).toBeDefined();
    expect(diagram.edges).toContainEqual(expect.objectContaining({
      source: copiedSourceId,
      target: copiedJoinId,
      targetHandle: "in-0",
    }));
  });

  it("duplicateNodes with an empty selection is a no-op", () => {
    const diagram = new Diagram();
    let calls = 0;
    diagram.onGraphChanged(() => calls++);

    const mapping = diagram.duplicateNodes([]);

    expect(calls).toBe(0);
    expect(mapping).toEqual([]);
    expect((diagram as any)._undoStack.length).toBe(0);
  });

  it("duplicates each selected node at most once when nodeIds contains repeats", () => {
    const diagram = new Diagram();
    const linear = getLinearStereotype(diagram);
    diagram.addModule(linear, 100, 100);
    const source = diagram.nodes.find((n) => !n.data.isInput)!;
    const nodesBefore = diagram.nodes.length;

    const mapping = diagram.duplicateNodes([source.id, source.id]);

    // The result is an originalId -> newId mapping, so each original must
    // correspond to exactly one created node even if an RPC caller repeats it.
    expect(mapping).toHaveLength(1);
    expect(diagram.nodes).toHaveLength(nodesBefore + 1);
    expect(diagram.getNodeById(mapping[0].newId)).toBeDefined();
  });

  it("duplicateNodes with a missing node is atomic (no mutation/notify)", () => {
    const diagram = new Diagram();
    const linear = getLinearStereotype(diagram);
    diagram.addModule(linear, 100, 100);
    const node = diagram.nodes.find((n) => !n.data.isInput)!;

    let calls = 0;
    diagram.onGraphChanged(() => calls++);
    const nodesBefore = diagram.nodes.length;
    const undoLenBefore = (diagram as any)._undoStack.length;

    expect(() => diagram.duplicateNodes([node.id, "ghost"])).toThrow("Node not found");
    expect(calls).toBe(0);
    expect(diagram.nodes.length).toBe(nodesBefore);
    expect((diagram as any)._undoStack.length).toBe(undoLenBefore);
  });

  it("create_subflow with label is one atomic operation", () => {
    const { diagram, dispatch } = createRpcHandler();
    let calls = 0;
    diagram.onGraphChanged(() => calls++);

    const response = dispatch("create-subflow", "create_subflow", {
      position: { x: 100, y: 100 },
      label: "Encoder",
    });

    // addSubGraph + updateModule(label) => exactly one notification.
    expect(calls).toBe(1);
    const subflowId = response.result.nodeId as string;
    const subflow = diagram.getNodeById(subflowId)!;
    expect(subflow.data.name).toBe("Encoder");
    expect(subflow.data.label).toBe("Encoder");

    // Exactly one undo snapshot: a single undo removes the whole subflow.
    expect(diagram.undo()).toBe(true);
    expect(diagram.getNodeById(subflowId)).toBeUndefined();
    expect(calls).toBe(2);
  });

  it("duplicate_nodes with nodes and edges is one atomic operation", () => {
    const { diagram, dispatch } = createRpcHandler();

    const inputResp = dispatch("create-input", "create_node", {
      stereotype: "Input",
      config: { params: { out_features: "784" } },
    });
    const linearResp = dispatch("create-linear", "create_node", {
      stereotype: "Linear",
      config: { params: { in_features: "784", out_features: "10" } },
    });
    const reluResp = dispatch("create-relu", "create_node", {
      stereotype: "ReLU",
    });
    const inputId = inputResp.result.nodeId;
    const linearId = linearResp.result.nodeId;
    const reluId = reluResp.result.nodeId;
    dispatch("connect-1", "connect_nodes", { source: inputId, target: linearId });
    dispatch("connect-2", "connect_nodes", { source: linearId, target: reluId });

    let calls = 0;
    diagram.onGraphChanged(() => calls++);

    const response = dispatch("duplicate", "duplicate_nodes", {
      nodeIds: [linearId, reluId],
      offset: { x: 50, y: 50 },
    });

    // Two addModule + one addEdge inside one batch => exactly one notification.
    expect(calls).toBe(1);
    expect(response.result.duplicated).toHaveLength(2);
    expect(diagram.nodes.length).toBe(5); // input + 2 originals + 2 duplicates

    // One undo snapshot restores the pre-duplicate state.
    expect(diagram.undo()).toBe(true);
    expect(diagram.nodes.length).toBe(3);
    expect(diagram.edges.length).toBe(2);
    expect(calls).toBe(2);
  });

  it("no-match disconnect and empty deletes/moves notify zero times", () => {
    const { diagram, dispatch } = createRpcHandler();

    const inputResp = dispatch("create-input", "create_node", {
      stereotype: "Input",
      config: { params: { out_features: "784" } },
    });
    const linearResp = dispatch("create-linear", "create_node", {
      stereotype: "Linear",
      config: { params: { in_features: "784", out_features: "10" } },
    });
    const inputId = inputResp.result.nodeId;
    const linearId = linearResp.result.nodeId;

    let calls = 0;
    diagram.onGraphChanged(() => calls++);

    // No matching edge => disconnect is a no-op, but the RPC still succeeds.
    const disc = dispatch("disconnect", "disconnect_nodes", {
      source: inputId,
      target: linearId,
    });
    expect(disc.result.removedEdgeIds).toEqual([]);
    expect(calls).toBe(0);

    // Empty deletes / moves are no-ops.
    dispatch("delete-nodes", "delete_nodes", { nodeIds: [] });
    dispatch("move-nodes", "move_nodes", { positions: [] });
    expect(calls).toBe(0);

    // Unchanged set_parameter / update_parameters / reset_parameters are no-ops.
    dispatch("set-param", "set_parameter", {
      nodeId: linearId,
      key: "out_features",
      value: "10", // already the current value
    });
    dispatch("update-params", "update_parameters", {
      nodeId: linearId,
      params: { in_features: "784", out_features: "10" },
    });
    dispatch("reset-params", "reset_parameters", {
      nodeId: linearId,
      keys: ["bias"], // already at the stereotype default
    });
    expect(calls).toBe(0);

    // A real change still notifies exactly once.
    dispatch("set-param-real", "set_parameter", {
      nodeId: linearId,
      key: "out_features",
      value: "128",
    });
    expect(calls).toBe(1);
  });

  it("core-level no-op guards skip undo capture and notification", () => {
    const diagram = new Diagram();
    let calls = 0;
    diagram.onGraphChanged(() => calls++);

    const linear = getLinearStereotype(diagram);
    diagram.addModule(linear, 100, 100); // 1 notification
    const node = diagram.nodes.find((n) => !n.data.isInput)!;

    // updateModule with identical values.
    diagram.updateModule(node.id, { color: node.data.color });
    // moveNode / moveNodes to the same position.
    diagram.moveNode(node.id, 100, 100);
    diagram.moveNodes([{ id: node.id, x: 100, y: 100 }]);
    // Unknown node / edge targets.
    diagram.updateModule("ghost", { color: "#000000" });
    diagram.deleteNode("ghost");
    diagram.deleteEdge("ghost-edge");
    diagram.moveNode("ghost", 0, 0);
    diagram.removeEdge("ghost", node.id);
    diagram.reconnectEdge("ghost-edge", "a", "b");
    expect(calls).toBe(1); // none of the above changed the graph

    // Equivalent reconnect (no field actually changes) is a no-op.
    diagram.addModule(linear, 200, 200); // 2 notifications
    const other = diagram.nodes.find((n) => !n.data.isInput && n.id !== node.id)!;
    const edge = diagram.addEdge(node.id, other.id); // 3 notifications
    diagram.reconnectEdge(edge.id, node.id, other.id, "out", "in");
    expect(calls).toBe(3); // equivalent reconnect did not notify

    // Undo count: every real mutation captured exactly one snapshot.
    const undoStack = (diagram as any)._undoStack as unknown[];
    expect(undoStack.length).toBe(3);
  });

  it("sameParams distinguishes arrays from plain objects recursively", () => {
    const diagram = new Diagram();
    let calls = 0;
    diagram.onGraphChanged(() => calls++);

    const linear = getLinearStereotype(diagram);
    diagram.addModule(linear, 100, 100);
    const node = diagram.nodes.find((n) => !n.data.isInput)!;
    expect(calls).toBe(1);

    // Same nested array => no-op (no notification).
    diagram.updateModule(node.id, { params: { out_features: { value: "10" }, tags: ["a", "b"] } });
    expect(calls).toBe(2); // real change (tags added)
    diagram.updateModule(node.id, { params: { out_features: { value: "10" }, tags: ["a", "b"] } });
    expect(calls).toBe(2); // identical nested array => no-op

    // Array vs plain object with identical string keys => DIFFERENT.
    diagram.updateModule(node.id, { params: { out_features: { value: "10" }, tags: { 0: "a", 1: "b" } } });
    expect(calls).toBe(3); // array changed into object => real change

    // Reordered object keys are still equal.
    diagram.updateModule(node.id, { params: { out_features: { value: "10" }, tags: { 1: "b", 0: "a" } } });
    expect(calls).toBe(3); // same object content => no-op
  });

  it("duplicate_nodes: missing node id is atomic (graph/stacks/notify unchanged)", () => {
    const { diagram, dispatch } = createRpcHandler();

    const linResp = dispatch("create-linear", "create_node", {
      stereotype: "Linear",
      config: { params: { in_features: "784", out_features: "10" } },
    });
    const linearId = linResp.result.nodeId;

    let calls = 0;
    diagram.onGraphChanged(() => calls++);
    const undoLen = (diagram as any)._undoStack.length;
    const graphBefore = diagram.exportToJson();

    const response = dispatch("dup-missing", "duplicate_nodes", {
      nodeIds: [linearId, "ghost-node"],
      offset: { x: 10, y: 10 },
    });
    expect(response.error.message).toContain("Node not found");
    expect(calls).toBe(0);
    expect((diagram as any)._undoStack.length).toBe(undoLen);
    expect(diagram.exportToJson()).toBe(graphBefore);
  });

  it("duplicate_nodes: missing stereotype is atomic (graph/stacks/notify unchanged)", () => {
    const { diagram, dispatch } = createRpcHandler();

    // Inject a node whose stereotype cannot be resolved.
    const ghost = { id: "ghost-stereo", type: "custom", position: { x: 0, y: 0 }, data: { stereotype: "NoSuchLayer", name: "ghost" } };
    diagram.nodes = [...diagram.nodes, ghost];

    let calls = 0;
    diagram.onGraphChanged(() => calls++);
    const undoLen = (diagram as any)._undoStack.length;
    const graphBefore = diagram.exportToJson();

    const response = dispatch("dup-ghost", "duplicate_nodes", {
      nodeIds: ["ghost-stereo"],
      offset: { x: 10, y: 10 },
    });
    expect(response.error.message).toContain("Stereotype not found");
    expect(calls).toBe(0);
    expect((diagram as any)._undoStack.length).toBe(undoLen);
    expect(diagram.exportToJson()).toBe(graphBefore);
  });

  it("a throwing listener does not stop peers or fail the RPC", () => {
    const { diagram, dispatch } = createRpcHandler();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    let peerCalls = 0;
    diagram.onGraphChanged(() => {
      throw new Error("listener boom");
    });
    diagram.onGraphChanged(() => peerCalls++);

    const response = dispatch("create-linear", "create_node", {
      stereotype: "Linear",
      config: { params: { in_features: "784", out_features: "10" } },
    });

    // The RPC still succeeded, the peer listener still ran, the error was logged.
    expect(response.error).toBeUndefined();
    expect(response.result.nodeId).toBeDefined();
    expect(peerCalls).toBe(1);
    expect(errorSpy).toHaveBeenCalled();

    // Undo remains functional even though the throwing listener runs again.
    expect(diagram.undo()).toBe(true);
    expect(peerCalls).toBe(2);

    errorSpy.mockRestore();
  });

  it("reentrant subscribe/unsubscribe during notification is deterministic", () => {
    const diagram = new Diagram();
    const linear = getLinearStereotype(diagram);
    const order: string[] = [];

    const unsubA = diagram.onGraphChanged(() => order.push("a"));
    diagram.onGraphChanged(() => {
      order.push("b");
      unsubA(); // unsubscribes a peer mid-round
    });
    diagram.onGraphChanged(() => {
      order.push("c");
      if (order.filter((x) => x === "d").length === 0) {
        diagram.onGraphChanged(() => order.push("d")); // subscribe mid-round
      }
    });

    diagram.addModule(linear, 100, 100);
    // Snapshot iteration: a, b, c all run this round; d is deferred.
    expect(order).toEqual(["a", "b", "c"]);

    diagram.addModule(linear, 200, 200);
    // a is gone; d runs from now on.
    expect(order).toEqual(["a", "b", "c", "b", "c", "d"]);
  });

  it("a listener that mutates the graph during notification is rejected", () => {
    const diagram = new Diagram();
    const linear = getLinearStereotype(diagram);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    let peerCalls = 0;
    let mutatingCalls = 0;
    diagram.onGraphChanged(() => {
      mutatingCalls++;
      // Rejected before any mutation/undo capture; no recursion occurs.
      diagram.addModule(linear, 500, 500);
    });
    diagram.onGraphChanged(() => peerCalls++);

    diagram.addModule(linear, 100, 100);

    // The original mutation applied; the listener's attempt was rejected.
    expect(diagram.nodes.length).toBe(2); // Input + outer addModule
    expect(peerCalls).toBe(1);
    expect(mutatingCalls).toBe(1); // the rejecting listener ran once
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

/** Create a BrowserRPCHandler with a real Diagram and a stubbed WebSocket. */
function createRpcHandler() {
  const diagram = new Diagram();
  diagram.nodes = [];
  diagram.edges = [];
  diagram.refreshTypes();

  const handler = new BrowserRPCHandler(diagram, "ws://localhost:0");
  const mockSend = vi.fn();
  (handler as any).ws = {
    send: mockSend,
    readyState: 1,
    close: vi.fn(),
  };

  const dispatch = (id: string, method: string, params: Record<string, unknown> = {}) => {
    mockSend.mockClear();
    (handler as any).handleMessage({
      data: JSON.stringify({ id, method, params }),
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
    return JSON.parse(mockSend.mock.calls[0][0]);
  };

  return { diagram, handler, mockSend, dispatch };
}

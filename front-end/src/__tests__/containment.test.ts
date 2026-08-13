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

import { afterAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Edge, Node } from "@xyflow/svelte";
import { Diagram } from "../Diagram.svelte";
import {
  normalizedScope,
  validateContainmentGraph,
} from "../core/containment";
import {
  checkValidConnection as checkCanvasConnection,
  onNodeDragStop,
  type NodeDragPayload,
} from "../utils";
import { edge, node, stubWindow, unstubWindow } from "./helpers";

stubWindow();
afterAll(() => unstubWindow());

function subflow(id: string, parentId?: string): Node {
  return node(id, "", id, {}, { type: "subflow", parentId });
}

function module(id: string, parentId?: string): Node {
  return node(id, "Linear", id, {}, { parentId });
}

function diagramWith(nodes: Node[], edges: Edge[] = []): Diagram {
  const diagram = new Diagram();
  diagram.nodes = nodes;
  diagram.edges = edges;
  return diagram;
}

function rejectedImportLeavesDiagramUntouched(diagram: Diagram, payload: unknown): void {
  const graphBefore = diagram.exportToJson();
  const undoLengthBefore = (diagram as any)._undoStack.length;
  let notifications = 0;
  diagram.onGraphChanged(() => notifications++);
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  try {
    expect(diagram.importFromJson(JSON.stringify(payload))).toBe(false);
  } finally {
    errorSpy.mockRestore();
  }

  expect(diagram.exportToJson()).toBe(graphBefore);
  expect((diagram as any)._undoStack.length).toBe(undoLengthBefore);
  expect(notifications).toBe(0);
}

const editableDiagramFixtures = [
  "../../../examples/diagrams/autoencoder_mnist.json",
  "../../../examples/diagrams/transformer_classifier.json",
  "../../../examples/diagrams/horizontal_multihead_attention.json",
  "../../../examples/diagrams/multihead_attention.json",
  "../../../examples/diagrams/skip_connections_with_repetition.json",
  "../../../examples/diagrams/mnist_skips.json",
  "../../../examples/diagrams/single_head_attention.json",
  "../../../examples/diagrams/mninst.json",
  "../../../examples/diagrams/auto_encoder_submodels_with_submodels.json",
  "../../../examples/diagrams/auto_encoder_submodels.json",
  "../../../examples/mcp_mnist_classifier.json",
];

describe("subflow containment boundaries", () => {
  it("normalizes top-level scope to null and retains immediate parent IDs", () => {
    expect(normalizedScope({ id: "top" } as Node)).toBeNull();
    expect(normalizedScope({ id: "child", parentId: "encoder" } as Node)).toBe("encoder");
  });

  it("accepts top-level, sibling and nested-sibling edge scopes", () => {
    const nodes = [
      module("top-a"),
      module("top-b"),
      subflow("encoder"),
      subflow("decoder"),
      module("encoder-a", "encoder"),
      module("encoder-b", "encoder"),
      subflow("nested", "encoder"),
      module("nested-child", "nested"),
      module("nested-sibling", "nested"),
      module("decoder-child", "decoder"),
    ];
    const diagram = diagramWith(nodes);

    expect(diagram.checkValidConnection("top-a", "top-b", "out", "in")).toBe(true);
    // A subflow is an atomic node in its direct parent's scope.
    expect(diagram.checkValidConnection("encoder", "top-b", "out", "in")).toBe(true);
    expect(diagram.checkValidConnection("encoder-a", "encoder-b", "out", "in")).toBe(true);
    expect(diagram.checkValidConnection("encoder-a", "nested", "out", "in")).toBe(true);
    expect(diagram.checkValidConnection("nested-child", "nested-sibling", "out", "in")).toBe(true);
    expect(diagram.checkValidConnection("nested-child", "nested-child", "out", "in")).toBe(false);
  });

  it("rejects child-to-parent, child-to-outside and cross-subflow connections", () => {
    const nodes = [
      module("top"),
      subflow("encoder"),
      subflow("decoder"),
      module("encoder-child", "encoder"),
      module("decoder-child", "decoder"),
    ];
    const diagram = diagramWith(nodes);

    expect(diagram.checkValidConnection("encoder-child", "encoder", "out", "in")).toBe(false);
    expect(diagram.checkValidConnection("encoder-child", "top", "out", "in")).toBe(false);
    expect(diagram.checkValidConnection("encoder-child", "decoder-child", "out", "in")).toBe(false);
    expect(checkCanvasConnection(diagram, {
      id: "canvas-attempt",
      source: "encoder-child",
      target: "top",
      sourceHandle: "out",
      targetHandle: "in",
    } as Edge)).toBe(false);
  });

  it("rejects cross-scope addEdge before undo capture or notification", () => {
    const diagram = diagramWith([
      module("top"),
      subflow("encoder"),
      module("child", "encoder"),
    ]);
    const graphBefore = diagram.exportToJson();
    const undoLengthBefore = (diagram as any)._undoStack.length;
    let notifications = 0;
    diagram.onGraphChanged(() => notifications++);

    expect(() => diagram.addEdge("child", "top")).toThrow(/containment scope/i);

    expect(diagram.exportToJson()).toBe(graphBefore);
    expect((diagram as any)._undoStack.length).toBe(undoLengthBefore);
    expect(notifications).toBe(0);
  });

  it("rejects a cross-scope reconnect before undo capture or notification", () => {
    const diagram = diagramWith(
      [module("top-a"), module("top-b"), subflow("encoder"), module("child", "encoder")],
      [edge("top-edge", "top-a", "top-b", { sourceHandle: "out", targetHandle: "in" })],
    );
    const graphBefore = diagram.exportToJson();
    const undoLengthBefore = (diagram as any)._undoStack.length;
    let notifications = 0;
    diagram.onGraphChanged(() => notifications++);

    expect(() => diagram.reconnectEdge("top-edge", undefined, "child")).toThrow(/containment scope/i);

    expect(diagram.exportToJson()).toBe(graphBefore);
    expect((diagram as any)._undoStack.length).toBe(undoLengthBefore);
    expect(notifications).toBe(0);
  });

  it("preserves cycle and target-handle occupancy validation on reconnect", () => {
    const occupiedTarget = diagramWith(
      [module("a"), module("b"), module("c"), module("d")],
      [
        edge("first", "a", "b", { targetHandle: "in" }),
        edge("second", "c", "d", { targetHandle: "in" }),
      ],
    );
    expect(() => occupiedTarget.reconnectEdge("second", undefined, "b", undefined, "in"))
      .toThrow(/already occupied/i);

    const cyclic = diagramWith(
      [module("a"), module("b"), module("c")],
      [edge("a-to-b", "a", "b"), edge("b-to-c", "b", "c")],
    );
    expect(() => cyclic.reconnectEdge("a-to-b", "c")).toThrow(/cycle/i);
  });

  it("blocks a reparent that would strand an incident edge across scopes", () => {
    const nodes = [
      subflow("left"),
      subflow("right"),
      module("child", "left"),
      module("sibling", "left"),
    ];
    const edges = [edge("internal", "child", "sibling")];
    const payload: NodeDragPayload = {
      event: {} as MouseEvent,
      targetNode: nodes[2],
      nodes,
    };

    const result = onNodeDragStop(
      payload,
      nodes,
      () => [nodes[1]],
      () => undefined,
      edges,
    );

    expect(result).toBeUndefined();
    expect(nodes.find((current) => current.id === "child")?.parentId).toBe("left");
    expect(edges).toEqual([edge("internal", "child", "sibling")]);
  });

  it("retains ancestry-loop protection and parents-before-children on valid reparenting", () => {
    const ancestor = subflow("ancestor");
    const descendant = subflow("descendant", "ancestor");
    const loopPayload: NodeDragPayload = {
      event: {} as MouseEvent,
      targetNode: ancestor,
      nodes: [ancestor, descendant],
    };
    expect(onNodeDragStop(loopPayload, [ancestor, descendant], () => [descendant], () => undefined, [])).toBeUndefined();

    const child = module("child");
    const parent = subflow("parent");
    const result = onNodeDragStop(
      { event: {} as MouseEvent, targetNode: child, nodes: [child, parent] },
      [child, parent],
      () => [parent],
      () => undefined,
      [],
    );

    expect(result?.map((current) => current.id)).toEqual(["parent", "child"]);
    expect(result?.find((current) => current.id === "child")?.parentId).toBe("parent");
  });

  it("imports a valid contained graph atomically", () => {
    const diagram = diagramWith([module("existing")]);
    let notifications = 0;
    diagram.onGraphChanged(() => notifications++);
    const importedNodes = [subflow("encoder"), module("first", "encoder"), module("second", "encoder")];

    expect(diagram.importFromJson(JSON.stringify({
      nodes: importedNodes,
      edges: [edge("internal", "first", "second")],
    }))).toBe(true);

    expect(diagram.nodes.map((current) => current.id)).toEqual(["encoder", "first", "second"]);
    expect(diagram.edges).toContainEqual(expect.objectContaining({
      id: "internal",
      sourceHandle: "out",
      targetHandle: "in",
    }));
    expect(notifications).toBe(1);
  });

  it("continues to import every checked-in editable diagram", () => {
    for (const fixture of editableDiagramFixtures) {
      const diagram = diagramWith([]);
      const json = readFileSync(new URL(fixture, import.meta.url), "utf8");
      expect(diagram.importFromJson(json), fixture).toBe(true);
    }
  });

  it("rejects imports with missing or non-subflow parents atomically", () => {
    const missingParent = {
      nodes: [module("child", "missing")],
      edges: [],
    };
    const nonSubflowParent = {
      nodes: [module("not-a-subflow"), module("child", "not-a-subflow")],
      edges: [],
    };

    rejectedImportLeavesDiagramUntouched(diagramWith([module("existing")]), missingParent);
    rejectedImportLeavesDiagramUntouched(diagramWith([module("existing")]), nonSubflowParent);
  });

  it("rejects imports with parent cycles or cross-scope edges atomically", () => {
    const parentCycle = {
      nodes: [subflow("first", "second"), subflow("second", "first")],
      edges: [],
    };
    const crossScopeEdge = {
      nodes: [module("top"), subflow("encoder"), module("child", "encoder")],
      edges: [edge("invalid", "top", "child")],
    };

    rejectedImportLeavesDiagramUntouched(diagramWith([module("existing")]), parentCycle);
    rejectedImportLeavesDiagramUntouched(diagramWith([module("existing")]), crossScopeEdge);
  });

  it("validates imported containment before edge scopes", () => {
    const result = validateContainmentGraph(
      [subflow("encoder"), module("child", "encoder")],
      [edge("internal", "child", "encoder")],
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/containment scope/i);
  });
});

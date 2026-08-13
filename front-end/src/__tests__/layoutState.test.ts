/*
 * NNModelling — DSL for designing neural networks via visual node editor
 * Copyright (C) 2026  Luca Sforza
 *
 * Licensed under the GNU General Public License v3 or later.
 * Commercial licenses are available — contact Luca Sforza.
 * See the LICENSE file for details.
 */

import type { Edge } from "@xyflow/svelte";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Diagram } from "../Diagram.svelte";
import { NNTree } from "../conversion/nnTree";
import { edge, node, stubWindow, unstubWindow } from "./helpers";

stubWindow();
afterAll(() => unstubWindow());

function geometryDiagram(): Diagram {
  const diagram = new Diagram();
  const input = node("input", "Input", "Input", {
    out_features: { value: "8" },
  }, { isInput: true });
  input.position = { x: 700, y: 500 };
  input.width = 30;
  input.height = 30;

  const linear = node("linear", "Linear", "Linear", {
    in_features: { value: "8" },
    out_features: { value: "4" },
  });
  linear.position = { x: 20, y: 10 };
  linear.width = 140;
  linear.height = 80;

  const subflow = node("repeat", "Repeat", "Repeat", {
    iterations: { value: "2", position: "top" },
  }, { type: "subflow" });
  subflow.position = { x: 450, y: 300 };
  subflow.width = 500;
  subflow.height = 350;
  subflow.data = {
    ...subflow.data,
    label: "Repeat",
    isCollapsed: false,
    oldWidth: 500,
    oldHeight: 350,
    isSubFlow: true,
  };

  const child = node("child", "ReLU", "ReLU", {}, { parentId: subflow.id });
  child.position = { x: 300, y: 200 };
  child.width = 140;
  child.height = 80;

  diagram.nodes = [input, linear, child, subflow];
  diagram.edges = [edge("input-linear", input.id, linear.id, {
    sourceHandle: "out",
    targetHandle: "in",
  })];
  diagram.refreshTypes();
  return diagram;
}

function forkDiagram(): Diagram {
  const diagram = new Diagram();
  const join = node("join", "Addition", "Addition", {}, { type: "join" });
  join.data = { ...join.data, inputsCount: 2 };
  diagram.nodes = [
    node("input", "Input", "Input", { out_features: { value: "8" } }, { isInput: true }),
    node("fork", "Fork", "Fork"),
    node("right", "ReLU", "Right"),
    node("left", "Tanh", "Left"),
    join,
    node("terminal", "ReLU", "Terminal"),
  ];
  diagram.edges = [
    edge("input-fork", "input", "fork", { sourceHandle: "out", targetHandle: "in" }),
    edge("fork-right", "fork", "right", { sourceHandle: "out", targetHandle: "in" }),
    edge("fork-left", "fork", "left", { sourceHandle: "out", targetHandle: "in" }),
    edge("right-join", "right", "join", { sourceHandle: "out", targetHandle: "in-0" }),
    edge("left-join", "left", "join", { sourceHandle: "out", targetHandle: "in-1" }),
    edge("join-terminal", "join", "terminal", { sourceHandle: "out", targetHandle: "in" }),
  ];
  diagram.refreshTypes();
  return diagram;
}

describe("automatic layout diagram state", () => {
  it("applies geometry and direction as one undoable notification", () => {
    const diagram = geometryDiagram();
    const nodesBefore = diagram.nodes;
    const edgesBefore = diagram.edges;
    const snapshotBefore = diagram.getSnapshot();
    let notifications = 0;
    diagram.onGraphChanged(() => notifications++);

    expect(diagram.autoLayout("horizontal")).toBe(true);

    expect(notifications).toBe(1);
    expect((diagram as any)._undoStack).toHaveLength(1);
    expect(diagram.layoutDirection).toBe("horizontal");
    expect(diagram.nodes).not.toBe(nodesBefore);
    expect(diagram.edges).not.toBe(edgesBefore);
    expect(diagram.edges).toEqual(edgesBefore);
    expect(diagram.nodes.find((candidate) => candidate.id === "repeat")?.data.oldWidth)
      .not.toBe(500);

    const snapshotAfter = diagram.getSnapshot();
    expect(diagram.undo()).toBe(true);
    expect(notifications).toBe(2);
    expect(diagram.layoutDirection).toBe("vertical");
    expect(diagram.nodes).toEqual(snapshotBefore.nodes);
    expect(diagram.edges).toEqual(snapshotBefore.edges);

    expect(diagram.redo()).toBe(true);
    expect(notifications).toBe(3);
    expect(diagram.layoutDirection).toBe("horizontal");
    expect(diagram.nodes).toEqual(snapshotAfter.nodes);
    expect(diagram.edges).toEqual(snapshotAfter.edges);
  });

  it("treats a repeated identical layout as a no-op", () => {
    const diagram = geometryDiagram();
    let notifications = 0;
    diagram.onGraphChanged(() => notifications++);

    expect(diagram.autoLayout("vertical")).toBe(true);
    const nodesAfterFirst = diagram.nodes;
    const undoCount = (diagram as any)._undoStack.length;
    expect(diagram.autoLayout("vertical")).toBe(false);

    expect(diagram.nodes).toBe(nodesAfterFirst);
    expect((diagram as any)._undoStack).toHaveLength(undoCount);
    expect(notifications).toBe(1);
  });

  it("rejects invalid directions and invalid containment before capture", () => {
    const diagram = geometryDiagram();
    let notifications = 0;
    diagram.onGraphChanged(() => notifications++);
    const before = diagram.exportToJson();
    const undoCount = (diagram as any)._undoStack.length;

    expect(() => diagram.autoLayout("diagonal" as any)).toThrow(/direction/i);
    expect(diagram.exportToJson()).toBe(before);
    expect((diagram as any)._undoStack).toHaveLength(undoCount);
    expect(notifications).toBe(0);

    const crossed = edge("crossed", "input", "child", {
      sourceHandle: "out",
      targetHandle: "in",
    });
    diagram.edges = [...diagram.edges, crossed];
    const invalidBefore = diagram.exportToJson();
    expect(() => diagram.autoLayout("horizontal")).toThrow(/containment|scope/i);
    expect(diagram.exportToJson()).toBe(invalidBefore);
    expect((diagram as any)._undoStack).toHaveLength(undoCount);
    expect(notifications).toBe(0);
  });

  it("round-trips horizontal metadata and defaults legacy or unknown values to vertical", () => {
    const source = geometryDiagram();
    source.autoLayout("horizontal");
    const exported = source.exportToJson();
    expect(JSON.parse(exported).layoutDirection).toBe("horizontal");

    const loaded = new Diagram();
    expect(loaded.importFromJson(exported)).toBe(true);
    expect(loaded.layoutDirection).toBe("horizontal");
    expect(JSON.parse(loaded.exportToJson())).toEqual(JSON.parse(exported));

    const legacy = JSON.parse(exported);
    delete legacy.layoutDirection;
    expect(loaded.importFromJson(JSON.stringify(legacy))).toBe(true);
    expect(loaded.layoutDirection).toBe("vertical");

    legacy.layoutDirection = "diagonal";
    loaded.layoutDirection = "horizontal";
    expect(loaded.importFromJson(JSON.stringify(legacy))).toBe(true);
    expect(loaded.layoutDirection).toBe("vertical");
  });

  it("keeps direction, graph, history and notifications unchanged after a rejected import", () => {
    const diagram = geometryDiagram();
    diagram.autoLayout("horizontal");
    const before = diagram.exportToJson();
    const undoCount = (diagram as any)._undoStack.length;
    let notifications = 0;
    diagram.onGraphChanged(() => notifications++);

    const invalid = JSON.parse(before);
    invalid.layoutDirection = "vertical";
    invalid.edges.push({
      id: "crossed",
      source: "input",
      target: "child",
      sourceHandle: "out",
      targetHandle: "in",
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(diagram.importFromJson(JSON.stringify(invalid))).toBe(false);

      expect(diagram.exportToJson()).toBe(before);
      expect(diagram.layoutDirection).toBe("horizontal");
      expect((diagram as any)._undoStack).toHaveLength(undoCount);
      expect(notifications).toBe(0);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("keeps edge identity and fork NNTree semantics unchanged", () => {
    const diagram = forkDiagram();
    const edgesBefore = diagram.edges;
    const edgeValuesBefore = structuredClone(diagram.edges) as Edge[];
    const treeBefore = new NNTree(diagram).toJson();

    expect(diagram.autoLayout("horizontal")).toBe(true);

    expect(diagram.edges).not.toBe(edgesBefore);
    expect(diagram.edges).toEqual(edgeValuesBefore);
    expect(new NNTree(diagram).toJson()).toBe(treeBefore);
  });
});

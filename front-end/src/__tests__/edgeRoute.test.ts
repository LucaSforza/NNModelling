/*
 * NNModelling — DSL for designing neural networks via visual node editor
 * Copyright (C) 2026  Luca Sforza
 *
 * Licensed under the GNU General Public License v3 or later.
 * Commercial licenses are available — contact Luca Sforza.
 * See the LICENSE file for details.
 */

import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Edge } from "@xyflow/svelte";
import { Diagram } from "../Diagram.svelte";
import { node, stubWindow, unstubWindow } from "./helpers";

stubWindow();
afterAll(() => unstubWindow());

function diagramWithEdge(): { diagram: Diagram; edgeId: string } {
  const diagram = new Diagram();
  diagram.nodes = [node("source", "Linear", "Source"), node("target", "Linear", "Target")];
  const edge = diagram.addEdge("source", "target");
  return { diagram, edgeId: edge.id };
}

describe("editable edge-route state", () => {
  it("creates editable edges with an automatic empty route", () => {
    const { diagram, edgeId } = diagramWithEdge();

    expect(diagram.edges.find((edge) => edge.id === edgeId)).toMatchObject({
      type: "editable",
      data: { route: { points: [] } },
    });
  });

  it("updates a route immutably as one undoable graph mutation", () => {
    const { diagram, edgeId } = diagramWithEdge();
    const before = diagram.edges[0];
    let notifications = 0;
    diagram.onGraphChanged(() => notifications++);

    expect(diagram.updateEdgeRoute(edgeId, [{ x: 20, y: 40 }])).toBe(true);

    const updated = diagram.edges[0];
    expect(notifications).toBe(1);
    expect((diagram as any)._undoStack).toHaveLength(2);
    expect(updated).not.toBe(before);
    expect(updated.data).not.toBe(before.data);
    expect(updated.data.route).toEqual({ points: [{ x: 20, y: 40 }] });
    expect(updated.source).toBe(before.source);
    expect(updated.target).toBe(before.target);
    expect(updated.sourceHandle).toBe(before.sourceHandle);
    expect(updated.targetHandle).toBe(before.targetHandle);

    expect(diagram.undo()).toBe(true);
    expect(notifications).toBe(2);
    expect(diagram.edges[0].data.route).toEqual({ points: [] });

    expect(diagram.redo()).toBe(true);
    expect(notifications).toBe(3);
    expect(diagram.edges[0].data.route).toEqual({ points: [{ x: 20, y: 40 }] });
  });

  it("normalizes an automatic legacy snapshot before undo and redo", () => {
    const diagram = new Diagram();
    diagram.nodes = [node("source", "Linear", "Source"), node("target", "Linear", "Target")];
    // Svelte Flow may create this valid automatic edge before DiagramCore sees
    // it: editable, but with no data object or route metadata yet.
    diagram.edges = [{
      id: "legacy-automatic",
      type: "editable",
      source: "source",
      target: "target",
      sourceHandle: "out",
      targetHandle: "in",
    } as Edge];

    expect(diagram.updateEdgeRoute("legacy-automatic", [{ x: 20, y: 40 }])).toBe(true);
    expect(diagram.undo()).toBe(true);
    expect(diagram.edges[0]).toMatchObject({
      type: "editable",
      data: { route: { points: [] } },
    });

    expect(diagram.redo()).toBe(true);
    expect(diagram.edges[0].data.route).toEqual({ points: [{ x: 20, y: 40 }] });
  });

  it("keeps a routed imported nested-subflow edge as the nearest undo entry", () => {
    const diagram = new Diagram();
    const fixture = readFileSync(
      new URL("../../../examples/diagrams/auto_encoder_submodels_with_submodels.json", import.meta.url),
      "utf8",
    );
    const edgeId = "xy-edge__subflow_1779202941276-subflow_1779203236563";

    expect(diagram.importFromJson(fixture)).toBe(true);
    expect(diagram.edges.some((edge) => edge.id === edgeId)).toBe(true);
    expect(diagram.updateEdgeRoute(edgeId, [{ x: 120, y: 220 }])).toBe(true);

    // Svelte Flow clears selection outside DiagramCore when the user clicks
    // the pane. That view-state replacement must not alter route history.
    diagram.edges = diagram.edges.map((edge) => ({ ...edge, selected: false }));

    expect(diagram.undo()).toBe(true);
    expect(diagram.edges.find((edge) => edge.id === edgeId)).toMatchObject({
      data: { route: { points: [] } },
    });

    expect(diagram.redo()).toBe(true);
    expect(diagram.edges.find((edge) => edge.id === edgeId)).toMatchObject({
      data: { route: { points: [{ x: 120, y: 220 }] } },
    });
  });

  it("rejects malformed and equal routes without history or notification", () => {
    const { diagram, edgeId } = diagramWithEdge();
    const undoLength = (diagram as any)._undoStack.length;
    let notifications = 0;
    diagram.onGraphChanged(() => notifications++);

    expect(diagram.updateEdgeRoute(edgeId, [{ x: Number.NaN, y: 0 }] as any)).toBe(false);
    expect(diagram.updateEdgeRoute(edgeId, [{ x: 0, y: Number.POSITIVE_INFINITY }] as any)).toBe(false);
    expect(diagram.updateEdgeRoute("missing-edge", [{ x: 1, y: 2 }])).toBe(false);
    expect(diagram.updateEdgeRoute(edgeId, [])).toBe(false);

    expect((diagram as any)._undoStack).toHaveLength(undoLength);
    expect(notifications).toBe(0);
    expect(diagram.edges[0].data.route).toEqual({ points: [] });
  });

  it("normalizes legacy imports and round-trips finite route points", () => {
    const diagram = new Diagram();
    const payload = {
      nodes: [
        node("source", "Linear", "Source"),
        node("target", "Linear", "Target"),
        node("routed-target", "Linear", "Routed target"),
      ],
      edges: [
        { id: "legacy", source: "source", target: "target" },
        {
          id: "routed",
          source: "source",
          target: "routed-target",
          data: { route: { points: [{ x: 15, y: 25 }] } },
        },
      ],
    };

    expect(diagram.importFromJson(JSON.stringify(payload))).toBe(true);
    expect(diagram.edges).toEqual([
      expect.objectContaining({
        id: "legacy",
        type: "editable",
        sourceHandle: "out",
        targetHandle: "in",
        data: { route: { points: [] } },
      }),
      expect.objectContaining({
        id: "routed",
        type: "editable",
        data: { route: { points: [{ x: 15, y: 25 }] } },
      }),
    ]);

    const reloaded = new Diagram();
    expect(reloaded.importFromJson(diagram.exportToJson())).toBe(true);
    expect(reloaded.edges).toEqual(diagram.edges);
  });

  it("clears a manual route when reconnecting an endpoint", () => {
    const { diagram, edgeId } = diagramWithEdge();
    diagram.nodes = [...diagram.nodes, node("replacement", "Linear", "Replacement")];
    diagram.updateEdgeRoute(edgeId, [{ x: 20, y: 40 }]);

    diagram.reconnectEdge(edgeId, undefined, "replacement");

    expect(diagram.edges[0]).toMatchObject({
      source: "source",
      target: "replacement",
      data: { route: { points: [] } },
    });
  });

  it("duplicates route points without aliasing the original internal edge", () => {
    const diagram = new Diagram();
    const linear = diagram.getStereotype("Linear");
    if (!linear) throw new Error("Linear stereotype not found");
    diagram.addModule(linear, 100, 100);
    diagram.addModule(linear, 250, 100);
    const [source, target] = diagram.nodes.filter((node) => !node.data.isInput);
    const original = diagram.addEdge(source.id, target.id);
    diagram.updateEdgeRoute(original.id, [{ x: 20, y: 40 }]);

    const copies = diagram.duplicateNodes([source.id, target.id]);
    const copiedSource = copies.find((copy) => copy.originalId === source.id)!.newId;
    const copiedTarget = copies.find((copy) => copy.originalId === target.id)!.newId;
    const copied = diagram.edges.find((edge) => edge.source === copiedSource && edge.target === copiedTarget)!;
    const originalRoute = diagram.edges.find((edge) => edge.id === original.id)!.data.route;
    const copiedRoute = copied.data.route;

    expect(copiedRoute).toEqual({ points: [{ x: 20, y: 40 }] });
    expect(copiedRoute).not.toBe(originalRoute);
    expect(copiedRoute.points).not.toBe(originalRoute.points);
  });
});

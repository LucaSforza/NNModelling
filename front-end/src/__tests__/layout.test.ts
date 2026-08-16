/*
 * NNModelling — DSL for designing neural networks via visual node editor
 * Copyright (C) 2026  Luca Sforza
 *
 * Licensed under the GNU General Public License v3 or later.
 * Commercial licenses are available — contact Luca Sforza.
 * See the LICENSE file for details.
 */

import type { Edge, Node } from "@xyflow/svelte";
import { describe, expect, it } from "vitest";
import {
  AUTO_LAYOUT_GEOMETRY,
  computeAutoLayout,
} from "../layout/autoLayout";

interface LayoutNodeOptions {
  type?: string;
  parentId?: string;
  position?: { x: number; y: number };
  width?: number;
  height?: number;
  measured?: { width?: number; height?: number };
  hidden?: boolean;
  data?: Record<string, unknown>;
}

function layoutNode(id: string, options: LayoutNodeOptions = {}): Node {
  return {
    id,
    type: options.type ?? "custom",
    position: options.position ?? { x: 900, y: 700 },
    width: options.width,
    height: options.height,
    measured: options.measured,
    parentId: options.parentId,
    hidden: options.hidden,
    data: {
      name: id,
      params: {},
      ...options.data,
    },
  } as Node;
}

function layoutEdge(
  id: string,
  source: string,
  target: string,
  targetHandle = "in",
): Edge {
  return {
    id,
    source,
    target,
    sourceHandle: "out",
    targetHandle,
  } as Edge;
}

function byId(nodes: readonly Node[], id: string): Node {
  const found = nodes.find((node) => node.id === id);
  if (!found) throw new Error(`Missing node '${id}'`);
  return found;
}

function overlaps(a: Node, b: Node): boolean {
  const aWidth = a.width ?? 0;
  const aHeight = a.height ?? 0;
  const bWidth = b.width ?? 0;
  const bHeight = b.height ?? 0;
  return !(
    a.position.x + aWidth <= b.position.x ||
    b.position.x + bWidth <= a.position.x ||
    a.position.y + aHeight <= b.position.y ||
    b.position.y + bHeight <= a.position.y
  );
}

describe("computeAutoLayout", () => {
  it("lays out a sequential graph top-to-bottom or left-to-right without mutating inputs", () => {
    const nodes = [
      layoutNode("input", { width: 30, height: 30, data: { isInput: true } }),
      layoutNode("hidden", { width: 140, height: 80, hidden: true }),
      layoutNode("loss", { width: 160, height: 60 }),
    ];
    const edges = [
      layoutEdge("input-hidden", "input", "hidden"),
      layoutEdge("hidden-loss", "hidden", "loss"),
    ];
    const sourceNodes = structuredClone(nodes);
    const sourceEdges = structuredClone(edges);

    const vertical = computeAutoLayout(nodes, edges, "vertical");
    const horizontal = computeAutoLayout(nodes, edges, "horizontal");

    expect(byId(vertical, "input").position.y).toBeLessThan(byId(vertical, "hidden").position.y);
    expect(byId(vertical, "hidden").position.y).toBeLessThan(byId(vertical, "loss").position.y);
    expect(byId(horizontal, "input").position.x).toBeLessThan(byId(horizontal, "hidden").position.x);
    expect(byId(horizontal, "hidden").position.x).toBeLessThan(byId(horizontal, "loss").position.x);
    expect(byId(vertical, "hidden").hidden).toBe(true);
    expect(nodes).toEqual(sourceNodes);
    expect(edges).toEqual(sourceEdges);
  });

  it("resolves measured, explicit, and join fallback dimensions in that order", () => {
    const nodes = [
      layoutNode("measured", {
        width: 40,
        height: 20,
        measured: { width: 220, height: 120 },
      }),
      layoutNode("explicit", { width: 170, height: 70 }),
      layoutNode("join", { type: "join", data: { inputsCount: 4 } }),
    ];
    const edges = [
      layoutEdge("measured-explicit", "measured", "explicit"),
      layoutEdge("explicit-join", "explicit", "join", "in-0"),
    ];

    const result = computeAutoLayout(nodes, edges, "vertical");

    expect(byId(result, "explicit").position.y).toBeGreaterThanOrEqual(
      120 + AUTO_LAYOUT_GEOMETRY.rankSeparation,
    );
    expect(byId(result, "join").position.y - byId(result, "explicit").position.y).toBeGreaterThanOrEqual(
      70 + AUTO_LAYOUT_GEOMETRY.rankSeparation,
    );
  });

  it("orients join geometry from its live input count instead of stale measurements", () => {
    const join = layoutNode("join", {
      type: "join",
      width: 164,
      height: 46,
      measured: { width: 164, height: 46 },
      data: { inputsCount: 3 },
    });

    const vertical = byId(computeAutoLayout([join], [], "vertical"), "join");
    const horizontal = byId(computeAutoLayout([join], [], "horizontal"), "join");

    expect({ width: vertical.width, height: vertical.height }).toEqual({
      width: 194,
      height: AUTO_LAYOUT_GEOMETRY.joinCrossSize,
    });
    expect({ width: horizontal.width, height: horizontal.height }).toEqual({
      width: AUTO_LAYOUT_GEOMETRY.joinCrossSize,
      height: 194,
    });
  });

  it("keeps fork, join, and skip-edge semantics while separating both directions", () => {
    const nodes = [
      layoutNode("fork", { width: 100, height: 60 }),
      layoutNode("left", { width: 120, height: 70 }),
      layoutNode("right", { width: 120, height: 70 }),
      layoutNode("join", { type: "join", width: 180, height: 80, data: { inputsCount: 3 } }),
    ];
    const edges = [
      layoutEdge("fork-left", "fork", "left"),
      layoutEdge("fork-right", "fork", "right"),
      layoutEdge("left-join", "left", "join", "in-0"),
      layoutEdge("right-join", "right", "join", "in-1"),
      layoutEdge("skip", "fork", "join", "in-2"),
    ];

    const vertical = computeAutoLayout(nodes, edges, "vertical");
    const horizontal = computeAutoLayout(nodes, edges, "horizontal");

    expect(byId(vertical, "fork").position.y).toBeLessThan(byId(vertical, "left").position.y);
    expect(byId(vertical, "fork").position.y).toBeLessThan(byId(vertical, "right").position.y);
    expect(byId(vertical, "left").position.y).toBeLessThan(byId(vertical, "join").position.y);
    expect(byId(vertical, "right").position.y).toBeLessThan(byId(vertical, "join").position.y);
    expect(overlaps(byId(vertical, "left"), byId(vertical, "right"))).toBe(false);

    expect(byId(horizontal, "fork").position.x).toBeLessThan(byId(horizontal, "left").position.x);
    expect(byId(horizontal, "fork").position.x).toBeLessThan(byId(horizontal, "right").position.x);
    expect(byId(horizontal, "left").position.x).toBeLessThan(byId(horizontal, "join").position.x);
    expect(byId(horizontal, "right").position.x).toBeLessThan(byId(horizontal, "join").position.x);
    expect(edges.map((edge) => edge.targetHandle)).toEqual(["in", "in", "in-0", "in-1", "in-2"]);
  });

  it("places disconnected nodes and components without overlap", () => {
    const nodes = [
      layoutNode("a", { width: 180, height: 80 }),
      layoutNode("b", { width: 160, height: 70 }),
      layoutNode("c", { width: 150, height: 90 }),
      layoutNode("d", { width: 140, height: 60 }),
    ];
    const edges = [layoutEdge("a-b", "a", "b")];

    const result = computeAutoLayout(nodes, edges, "vertical");

    for (let i = 0; i < result.length; i += 1) {
      for (let j = i + 1; j < result.length; j += 1) {
        expect(overlaps(result[i], result[j])).toBe(false);
      }
    }
  });

  it("grows and shrinks expanded subflows around their direct contents", () => {
    const nodes = [
      layoutNode("grow", { type: "subflow", width: 100, height: 50, data: { isCollapsed: false } }),
      layoutNode("large-child", { parentId: "grow", width: 420, height: 120 }),
      layoutNode("shrink", { type: "subflow", width: 1600, height: 1200, data: { isCollapsed: false } }),
      layoutNode("small-child", { parentId: "shrink", width: 100, height: 50 }),
    ];

    const result = computeAutoLayout(nodes, [], "vertical");
    const grown = byId(result, "grow");
    const shrunk = byId(result, "shrink");

    expect(grown.width).toBeGreaterThan(100);
    expect(grown.width).toBeGreaterThanOrEqual(420 + AUTO_LAYOUT_GEOMETRY.subflowSidePadding * 2);
    expect(grown.data.oldWidth).toBe(grown.width);
    expect(grown.data.oldHeight).toBe(grown.height);
    expect(shrunk.width).toBeLessThan(1600);
    expect(shrunk.height).toBeLessThan(1200);
    expect(shrunk.data.oldWidth).toBe(shrunk.width);
    expect(shrunk.data.oldHeight).toBe(shrunk.height);
  });

  it("reserves subflow header and rendered parameter insets", () => {
    const nodes = [
      layoutNode("parameterized", {
        type: "subflow",
        width: 400,
        height: 300,
        data: {
          stereotype: "Repeat",
          isCollapsed: false,
          params: {
            iterations: { value: "2", position: "top" },
            mode: { value: "sum", position: "bottom" },
          },
        },
      }),
      layoutNode("child", { parentId: "parameterized", width: 120, height: 60 }),
    ];

    const result = computeAutoLayout(nodes, [], "vertical");
    const parent = byId(result, "parameterized");
    const child = byId(result, "child");
    const expectedTop =
      AUTO_LAYOUT_GEOMETRY.subflowHeaderHeight +
      AUTO_LAYOUT_GEOMETRY.subflowParameterRowHeight +
      AUTO_LAYOUT_GEOMETRY.subflowContentTopPadding;

    expect(child.position.y).toBe(expectedTop);
    expect(parent.height).toBeGreaterThanOrEqual(
      expectedTop +
      60 +
      AUTO_LAYOUT_GEOMETRY.subflowParameterRowHeight +
      AUTO_LAYOUT_GEOMETRY.subflowContentBottomPadding,
    );
  });

  it("lays out nested scopes bottom-up and returns parents before descendants while preserving sibling order", () => {
    const nodes = [
      layoutNode("inner-b", { parentId: "inner", width: 90, height: 50 }),
      layoutNode("outer-sibling", { parentId: "outer", width: 110, height: 60 }),
      layoutNode("inner-a", { parentId: "inner", width: 100, height: 60 }),
      layoutNode("inner", { type: "subflow", parentId: "outer", width: 80, height: 50, data: { isCollapsed: false } }),
      layoutNode("outer", { type: "subflow", width: 100, height: 50, data: { isCollapsed: false } }),
    ];
    const edges = [layoutEdge("inner-a-b", "inner-a", "inner-b")];

    const result = computeAutoLayout(nodes, edges, "vertical");
    const outer = byId(result, "outer");
    const inner = byId(result, "inner");
    const innerA = byId(result, "inner-a");
    const innerB = byId(result, "inner-b");

    expect(result.map((node) => node.id)).toEqual([
      "outer",
      "inner",
      "inner-b",
      "outer-sibling",
      "inner-a",
    ]);
    expect(inner.position.x).toBeGreaterThanOrEqual(AUTO_LAYOUT_GEOMETRY.subflowSidePadding);
    expect(inner.position.y).toBeGreaterThanOrEqual(
      AUTO_LAYOUT_GEOMETRY.subflowHeaderHeight + AUTO_LAYOUT_GEOMETRY.subflowContentTopPadding,
    );
    expect(innerA.position.x).toBeGreaterThanOrEqual(AUTO_LAYOUT_GEOMETRY.subflowSidePadding);
    expect(innerB.position.y).toBeGreaterThan(innerA.position.y);
    expect(outer.width).toBeGreaterThanOrEqual(inner.position.x + (inner.width ?? 0) + AUTO_LAYOUT_GEOMETRY.subflowSidePadding);
    expect(outer.height).toBeGreaterThan(inner.position.y + (inner.height ?? 0));
  });

  it("lays out hidden descendants while a collapsed subflow remains compact", () => {
    const nodes = [
      layoutNode("collapsed", {
        type: "subflow",
        width: 250,
        height: 50,
        data: { isCollapsed: true, oldWidth: 400, oldHeight: 300 },
      }),
      layoutNode("first", {
        parentId: "collapsed",
        width: 160,
        height: 80,
        hidden: true,
        position: { x: 600, y: 600 },
      }),
      layoutNode("second", {
        parentId: "collapsed",
        width: 120,
        height: 60,
        hidden: true,
        position: { x: 600, y: 600 },
      }),
    ];
    const edges = [{ ...layoutEdge("first-second", "first", "second"), hidden: true }];

    const result = computeAutoLayout(nodes, edges, "vertical");
    const collapsed = byId(result, "collapsed");
    const first = byId(result, "first");
    const second = byId(result, "second");

    expect(collapsed.width).toBe(AUTO_LAYOUT_GEOMETRY.collapsedSubflowWidth);
    expect(collapsed.height).toBe(AUTO_LAYOUT_GEOMETRY.collapsedSubflowHeight);
    expect(collapsed.data.oldWidth).toBeGreaterThan(160);
    expect(collapsed.data.oldHeight).toBeGreaterThan(80 + 60);
    expect(first.hidden).toBe(true);
    expect(second.hidden).toBe(true);
    expect(first.position).not.toEqual({ x: 600, y: 600 });
    expect(second.position.y).toBeGreaterThan(first.position.y);
    expect(edges[0].hidden).toBe(true);
  });

  it("is stable across repeated calls in either direction", () => {
    const nodes = [
      layoutNode("outer", { type: "subflow", width: 700, height: 500, data: { isCollapsed: false } }),
      layoutNode("collapsed", {
        type: "subflow",
        parentId: "outer",
        width: 250,
        height: 50,
        data: { isCollapsed: true, oldWidth: 500, oldHeight: 400 },
      }),
      layoutNode("hidden-a", { parentId: "collapsed", width: 120, height: 60, hidden: true }),
      layoutNode("hidden-b", { parentId: "collapsed", width: 140, height: 70, hidden: true }),
      layoutNode("outer-child", { parentId: "outer", width: 150, height: 80 }),
      layoutNode("top", { width: 100, height: 60 }),
    ];
    const edges = [
      layoutEdge("hidden-a-b", "hidden-a", "hidden-b"),
      layoutEdge("collapsed-child", "collapsed", "outer-child"),
      layoutEdge("top-outer", "top", "outer"),
    ];

    for (const direction of ["vertical", "horizontal"] as const) {
      const once = computeAutoLayout(nodes, edges, direction);
      const twice = computeAutoLayout(once, edges, direction);
      expect(twice).toEqual(once);
    }
  });
});

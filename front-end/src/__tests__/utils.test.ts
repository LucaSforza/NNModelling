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

import { describe, it, expect, afterAll } from "vitest";
import { type Edge, type Node } from "@xyflow/svelte";
import { Diagram } from "../Diagram.svelte";
import type { ActivePackageMetadata } from "../type-system/host";
import { checkValidConnection, findDockedConnection, type DockHandleRect } from "../utils";
import { stubWindow, unstubWindow } from "./helpers";

stubWindow();
afterAll(() => unstubWindow());

describe("checkValidConnection", () => {
  it("allows connection when no edges exist", () => {
    const d = new Diagram();
    d.edges = [];
    const conn = { source: "a", sourceHandle: null, target: "b", targetHandle: "in-0" };
    expect(checkValidConnection(d, conn)).toBe(true);
  });

  it("allows connection when target is different from all existing edges", () => {
    const d = new Diagram();
    d.edges = [
      { id: "e1", source: "x", target: "y", targetHandle: "in-0" } as Edge,
    ];
    const conn = { source: "a", sourceHandle: null, target: "b", targetHandle: "in-0" };
    expect(checkValidConnection(d, conn)).toBe(true);
  });

  it("allows connection when same target but different handle", () => {
    const d = new Diagram();
    d.edges = [
      { id: "e1", source: "x", target: "b", targetHandle: "in-0" } as Edge,
    ];
    const conn = { source: "a", sourceHandle: null, target: "b", targetHandle: "in-1" };
    expect(checkValidConnection(d, conn)).toBe(true);
  });

  it("blocks connection when same target + same targetHandle is taken", () => {
    const d = new Diagram();
    d.edges = [
      { id: "e1", source: "x", target: "b", targetHandle: "in-0" } as Edge,
    ];
    const conn = { source: "a", sourceHandle: null, target: "b", targetHandle: "in-0" };
    expect(checkValidConnection(d, conn)).toBe(false);
  });

  it("blocks when passed an existing Edge instead of Connection", () => {
    const existingEdge: Edge = {
      id: "e1",
      source: "x",
      target: "b",
      targetHandle: "in-0",
    };
    const d = new Diagram();
    d.edges = [existingEdge];
    expect(checkValidConnection(d, existingEdge)).toBe(false);
  });

  it("allows connection when target handle is null and free", () => {
    const d = new Diagram();
    d.edges = [];
    const conn = { source: "a", sourceHandle: null, target: "b", targetHandle: null };
    expect(checkValidConnection(d, conn)).toBe(true);
  });

  it("blocks connection when target handle is null but another edge with null already exists", () => {
    const d = new Diagram();
    d.edges = [
      { id: "e1", source: "x", target: "b" } as Edge,
    ];
    const conn = { source: "a", sourceHandle: null, target: "b", targetHandle: null };
    expect(checkValidConnection(d, conn)).toBe(false);
  });

  it("allows connection to join node with multiple inputs when specific free handle exists", () => {
    const d = new Diagram();
    d.edges = [
      { id: "e1", source: "x", target: "join1", targetHandle: "in-0" } as Edge,
    ];
    const conn = { source: "a", sourceHandle: null, target: "join1", targetHandle: "in-1" };
    expect(checkValidConnection(d, conn)).toBe(true);
  });

  it("blocks connection to join node when specific handle is already used", () => {
    const d = new Diagram();
    d.edges = [
      { id: "e1", source: "x", target: "join1", targetHandle: "in-0" } as Edge,
    ];
    const conn = { source: "a", sourceHandle: null, target: "join1", targetHandle: "in-0" };
    expect(checkValidConnection(d, conn)).toBe(false);
  });

  it("allows source handle duplicates (source handles not checked)", () => {
    const d = new Diagram();
    d.edges = [
      { id: "e1", source: "a", sourceHandle: "out", target: "b", targetHandle: "in-0" } as Edge,
    ];
    const conn = { source: "a", sourceHandle: "out", target: "c", targetHandle: "in-0" };
    expect(checkValidConnection(d, conn)).toBe(true);
  });

  it("blocks a connection that would close a directed cycle", () => {
    const d = new Diagram();
    d.edges = [
      { id: "e1", source: "a", target: "b", targetHandle: "in" } as Edge,
      { id: "e2", source: "b", target: "c", targetHandle: "in" } as Edge,
    ];
    // c -> a closes a -> b -> c -> a.
    const conn = { source: "c", sourceHandle: "out", target: "a", targetHandle: "in" };
    expect(checkValidConnection(d, conn)).toBe(false);
  });

  it("allows a DAG reconvergence where two branches merge into a join", () => {
    const d = new Diagram();
    d.edges = [
      { id: "e1", source: "a", target: "join", targetHandle: "in-0" } as Edge,
    ];
    // b -> join (free in-1 handle) merges two branches without forming a cycle.
    const conn = { source: "b", sourceHandle: "out", target: "join", targetHandle: "in-1" };
    expect(checkValidConnection(d, conn)).toBe(true);
  });

  it("allows a diamond closing edge (both branches feed the join)", () => {
    const d = new Diagram();
    d.edges = [
      { id: "e1", source: "a", target: "b", targetHandle: "in" } as Edge,
      { id: "e2", source: "a", target: "c", targetHandle: "in" } as Edge,
      { id: "e3", source: "b", target: "join", targetHandle: "in-0" } as Edge,
    ];
    // c -> join merges the second diamond branch; no path from join back to c.
    const conn = { source: "c", sourceHandle: "out", target: "join", targetHandle: "in-1" };
    expect(checkValidConnection(d, conn)).toBe(true);
  });
});

describe("findDockedConnection", () => {
  const handle = (
    nodeId: string,
    handleId: string,
    type: DockHandleRect["type"],
    x: number,
    y: number,
  ): DockHandleRect => ({
    nodeId,
    handleId,
    type,
    rect: { x, y, width: 4, height: 4 },
  });

  it("returns the logical connection when the target is dropped on an output", () => {
    expect(findDockedConnection("target", [
      handle("source", "out", "source", 100, 100),
      handle("target", "in", "target", 104, 100),
    ])).toEqual({
      source: "source",
      sourceHandle: "out",
      target: "target",
      targetHandle: "in",
    });
  });

  it("requires a precise drop and ignores unrelated handles", () => {
    expect(findDockedConnection("target", [
      handle("source", "out", "source", 100, 100),
      handle("target", "in", "target", 120, 100),
      handle("other", "out", "source", 100, 100),
    ])).toBeUndefined();
  });

  it("chooses the nearest free-looking target handle for a join", () => {
    expect(findDockedConnection("join", [
      handle("source", "out", "source", 100, 100),
      handle("join", "in-0", "target", 130, 100),
      handle("join", "in-1", "target", 104, 100),
    ])).toEqual({
      source: "source",
      sourceHandle: "out",
      target: "join",
      targetHandle: "in-1",
    });
  });
});

describe("docked edge metadata", () => {
  it("persists docking as presentation metadata without changing edge semantics", () => {
    const d = new Diagram();
    d.nodes = [
      { id: "source", type: "custom", position: { x: 0, y: 0 }, data: {} },
      { id: "target", type: "custom", position: { x: 0, y: 100 }, data: {} },
    ] as Node[];

    const edge = d.addEdge("source", "target", "out", "in", { docked: true });

    expect(edge.data).toMatchObject({ docked: true });
    expect(d.isDockedEdge(edge)).toBe(true);
    expect(d.isDockedEdge({ ...edge, data: { route: { points: [] } } })).toBe(false);
    expect(d.edges).toContainEqual(edge);
  });
});

describe("layer docking invariant", () => {
  it("recognizes only package nodes whose catalog kind is layer", () => {
    const d = new Diagram();
    d.packageCatalog = [
      {
        id: "core.linear",
        version: "0.1.0",
        definition: { kind: "layer" },
      },
    ] as unknown as ActivePackageMetadata[];

    const layer = {
      id: "layer",
      type: "custom",
      position: { x: 0, y: 0 },
      data: { package: { id: "core.linear", version: "0.1.0" } },
    } as Node;
    const input = {
      ...layer,
      id: "input",
      data: { package: { id: "core.input", version: "0.1.0" } },
    } as Node;

    expect(d.isLayerNode(layer)).toBe(true);
    expect(d.isLayerNode(input)).toBe(false);
  });
});

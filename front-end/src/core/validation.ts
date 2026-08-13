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

import type { Edge } from "@xyflow/svelte";
import { validateSameScopeEdge } from "./containment";

export interface ConnectionValidation {
  valid: boolean;
  reason?: string;
}

export interface ValidationError {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface ValidationWarning {
  code: string;
  message: string;
  nodeId?: string;
}

export interface GraphValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface DirectedEdge {
  source: string;
  target: string;
}

/**
 * Detect a directed cycle in a graph of node IDs and directed edges using
 * DFS three-coloring: WHITE (unvisited), GRAY (on the current DFS path),
 * BLACK (fully completed).
 *
 * This distinguishes a genuine back-edge (a node on the current DFS path) —
 * the only case that forms a directed cycle — from a legitimate cross-edge
 * where a node that has already been completed is reached again, which is
 * exactly what happens when two branches of a DAG reconverge on a join. A
 * reconvergent DAG therefore reports no cycle.
 *
 * Returns the node IDs of the first detected cycle in path order (closing
 * back onto itself), or null when the graph is acyclic.
 */
export function findDirectedCycle(
  nodeIds: Iterable<string>,
  edges: Iterable<DirectedEdge>,
): string[] | null {
  const ids = new Set(nodeIds);
  const adjacency = new Map<string, string[]>();
  for (const id of ids) adjacency.set(id, []);
  for (const edge of edges) {
    if (ids.has(edge.source) && ids.has(edge.target)) {
      adjacency.get(edge.source)!.push(edge.target);
    }
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of ids) color.set(id, WHITE);
  const path: string[] = [];

  const visit = (node: string): string[] | null => {
    color.set(node, GRAY);
    path.push(node);
    for (const next of adjacency.get(node) ?? []) {
      if (color.get(next) === GRAY) {
        const start = path.indexOf(next);
        return [...path.slice(start), next];
      }
      if (color.get(next) === WHITE) {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
    }
    path.pop();
    color.set(node, BLACK);
    return null;
  };

  for (const id of ids) {
    if (color.get(id) === WHITE) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return null;
}

/**
 * Check if a connection is valid based on target handle availability and
 * directed acyclicity.
 * Extracted from utils.ts:checkValidConnection — operates on plain Edge[],
 * not a Diagram instance.
 */
export function checkValidConnection(
  edges: Edge[],
  source: string,
  target: string,
  sourceHandle?: string,
  targetHandle?: string,
  nodes?: readonly unknown[],
): ConnectionValidation {
  // Self-loop check
  if (source === target) {
    return { valid: false, reason: "Cannot connect a node to itself" };
  }

  // A connection belongs to exactly one immediate containment scope. This
  // runs before cycle and handle checks so the caller can reject the mutation
  // before it captures undo state or changes the edge array.
  if (nodes) {
    const containment = validateSameScopeEdge(nodes, { source, target });
    if (!containment.valid) {
      return { valid: false, reason: containment.reason };
    }
  }

  // Directed-cycle check: adding source → target creates a cycle exactly when
  // the existing graph already contains a directed path from target to source.
  // This must run before the handle-occupancy check so a back-edge targeting
  // an occupied input is still reported as a cycle.
  const nodeIds = new Set<string>([source, target]);
  for (const e of edges) {
    nodeIds.add(e.source);
    nodeIds.add(e.target);
  }
  const cycle = findDirectedCycle(nodeIds, [...edges, { source, target }]);
  if (cycle) {
    return {
      valid: false,
      reason: `Connection would create a directed cycle: ${cycle.join(" -> ")}`,
    };
  }

  // Target handle occupancy check
  const isTargetTaken = edges.some(
    (e) => e.target === target && e.targetHandle === targetHandle
  );

  if (isTargetTaken) {
    return { valid: false, reason: `Target handle '${targetHandle}' on node '${target}' is already occupied` };
  }

  return { valid: true };
}

// Future: validateGraph, validateConnections, validateParameters, validateSubflows
// will be added here in Phase 2 when the MCP server needs them.
// For Phase 1, only checkValidConnection is extracted.

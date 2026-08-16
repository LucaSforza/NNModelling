/*
 * NNModelling — DSL for designing neural networks via visual node editor
 * Copyright (C) 2026  Luca Sforza
 *
 * Licensed under the GNU General Public License v3 or later.
 * Commercial licenses are available — contact Luca Sforza.
 * See the LICENSE file for details.
 */

import type { Edge } from "@xyflow/svelte";
import type { EdgeRoutePoint } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function edgeData(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * Validates and copies persisted route points. Empty routes are valid and
 * select automatic routing; malformed values are intentionally rejected.
 */
export function normalizeRoutePoints(value: unknown): EdgeRoutePoint[] | null {
  if (!Array.isArray(value)) return null;

  const points: EdgeRoutePoint[] = [];
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      typeof candidate.x !== "number" || !Number.isFinite(candidate.x) ||
      typeof candidate.y !== "number" || !Number.isFinite(candidate.y)
    ) {
      return null;
    }
    points.push({ x: candidate.x, y: candidate.y });
  }
  return points;
}

/** Read valid route metadata from edge data; absent or malformed metadata is automatic. */
export function routePointsFromData(data: unknown): EdgeRoutePoint[] {
  const route = edgeData(data).route;
  if (!isRecord(route)) return [];
  return normalizeRoutePoints(route.points) ?? [];
}

/** Structural equality for normalized route points. */
export function sameRoutePoints(
  left: readonly EdgeRoutePoint[],
  right: readonly EdgeRoutePoint[],
): boolean {
  return left.length === right.length && left.every((point, index) => (
    point.x === right[index]?.x && point.y === right[index]?.y
  ));
}

/**
 * Creates the canonical editable-edge representation without sharing route
 * point objects. Import and duplication use this to keep route data durable.
 */
export function edgeWithRoutePoints(edge: Edge, points: readonly EdgeRoutePoint[]): Edge {
  return {
    ...edge,
    type: "editable",
    data: {
      ...edgeData(edge.data),
      route: { points: points.map((point) => ({ ...point })) },
    },
  };
}

/** Normalize an edge imported from legacy JSON into the editable-edge contract. */
export function normalizeEditableEdge(edge: Edge): Edge {
  return edgeWithRoutePoints(edge, routePointsFromData(edge.data));
}

/*
 * NNModelling — DSL for designing neural networks via visual node editor
 * Copyright (C) 2026  Luca Sforza
 *
 * Licensed under the GNU General Public License v3 or later.
 * Commercial licenses are available — contact Luca Sforza.
 * See the LICENSE file for details.
 */

export type RoutePoint = { x: number; y: number };

export type EdgeDirection = "left" | "right" | "top" | "bottom" | undefined;

export type OrthogonalPathOptions = {
  source: RoutePoint;
  target: RoutePoint;
  sourcePosition: EdgeDirection;
  targetPosition: EdgeDirection;
  points?: unknown;
  scopeOrigin?: RoutePoint;
};

function isFinitePoint(value: unknown): value is RoutePoint {
  return typeof value === "object" && value !== null &&
    typeof (value as RoutePoint).x === "number" && Number.isFinite((value as RoutePoint).x) &&
    typeof (value as RoutePoint).y === "number" && Number.isFinite((value as RoutePoint).y);
}

/** Invalid or legacy route data is deliberately rendered as automatic geometry. */
export function normalizePathPoints(value: unknown): RoutePoint[] | null {
  if (!Array.isArray(value)) return null;
  const points: RoutePoint[] = [];
  for (const point of value) {
    if (!isFinitePoint(point)) return null;
    points.push({ x: point.x, y: point.y });
  }
  return points;
}

function isHorizontal(direction: EdgeDirection): boolean {
  return direction === "left" || direction === "right";
}

function opposite(axis: "horizontal" | "vertical"): "horizontal" | "vertical" {
  return axis === "horizontal" ? "vertical" : "horizontal";
}

function appendPoint(points: RoutePoint[], point: RoutePoint): void {
  const previous = points.at(-1);
  if (!previous || previous.x !== point.x || previous.y !== point.y) points.push(point);
}

function appendOrthogonalSegment(
  path: RoutePoint[],
  next: RoutePoint,
  firstAxis: "horizontal" | "vertical",
): void {
  const previous = path.at(-1);
  if (!previous) return;
  if (previous.x !== next.x && previous.y !== next.y) {
    appendPoint(path, firstAxis === "horizontal"
      ? { x: next.x, y: previous.y }
      : { x: previous.x, y: next.y });
  }
  appendPoint(path, next);
}

function automaticPoints(
  source: RoutePoint,
  target: RoutePoint,
  sourcePosition: EdgeDirection,
  targetPosition: EdgeDirection,
): RoutePoint[] {
  if (source.x === target.x || source.y === target.y) return [source, target];

  const sourceAxis = isHorizontal(sourcePosition) ? "horizontal" : "vertical";
  const targetAxis = isHorizontal(targetPosition) ? "horizontal" : "vertical";
  const path = [source];

  if (sourceAxis === targetAxis) {
    const midpoint = sourceAxis === "horizontal"
      ? { x: (source.x + target.x) / 2, y: source.y }
      : { x: source.x, y: (source.y + target.y) / 2 };
    const turn = sourceAxis === "horizontal"
      ? { x: midpoint.x, y: target.y }
      : { x: target.x, y: midpoint.y };
    appendPoint(path, midpoint);
    appendPoint(path, turn);
  } else if (sourceAxis === "horizontal") {
    appendPoint(path, { x: target.x, y: source.y });
  } else {
    appendPoint(path, { x: source.x, y: target.y });
  }

  appendPoint(path, target);
  return path;
}

function manualPoints(
  source: RoutePoint,
  target: RoutePoint,
  points: RoutePoint[],
  sourcePosition: EdgeDirection,
  targetPosition: EdgeDirection,
): RoutePoint[] {
  const path = [source];
  const destinations = [...points, target];
  const sourceAxis = isHorizontal(sourcePosition) ? "horizontal" : "vertical";
  const targetAxis = isHorizontal(targetPosition) ? "horizontal" : "vertical";

  for (const [index, destination] of destinations.entries()) {
    // Leave the source and enter the target in their handle directions. The
    // intervening elbows alternate deterministically without being persisted.
    const axis = index === 0
      ? sourceAxis
      : index === destinations.length - 1
        ? opposite(targetAxis)
        : index % 2 === 0 ? sourceAxis : opposite(sourceAxis);
    appendOrthogonalSegment(path, destination, axis);
  }

  return path;
}

function format(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

/**
 * Converts endpoint geometry and scope-local route points into an SVG
 * orthogonal polyline. It has no dependency on Svelte Flow or Diagram state.
 */
export function getOrthogonalRoutePath({
  source,
  target,
  sourcePosition,
  targetPosition,
  points,
  scopeOrigin = { x: 0, y: 0 },
}: OrthogonalPathOptions): string {
  const normalizedPoints = normalizePathPoints(points);
  const route = normalizedPoints && normalizedPoints.length > 0
    ? manualPoints(
      source,
      target,
      normalizedPoints.map((point) => ({
        x: point.x + scopeOrigin.x,
        y: point.y + scopeOrigin.y,
      })),
      sourcePosition,
      targetPosition,
    )
    : automaticPoints(source, target, sourcePosition, targetPosition);

  return route.map((point, index) => (
    `${index === 0 ? "M" : "L"} ${format(point.x)} ${format(point.y)}`
  )).join(" ");
}

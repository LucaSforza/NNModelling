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

// Re-export Svelte Flow types (type-only — no runtime dependency)
import type { Node, Edge } from "@xyflow/svelte";
import type { LayoutDirection } from "../layout/autoLayout";
export type { Node, Edge };
export type { LayoutDirection };

// ── Position ────────────────────────────────────
export interface Position { x: number; y: number; }

/** A finite bend position stored in an edge's immediate containment scope. */
export interface EdgeRoutePoint {
  x: number;
  y: number;
}

/** Persisted route metadata carried by editable Svelte Flow edges. */
export interface EdgeRouteData {
  route: {
    points: EdgeRoutePoint[];
  };
}

// ── Node Configuration ──────────────────────────
export interface NodeConfig {
  name?: string;
  color?: string;
  width?: number;
  height?: number;
  params?: Record<string, any>;
}

export interface JoinNodeConfig extends NodeConfig {
  inputsCount?: number;
}

/** The total handle range declared by a signature's ordered input groups. */
export interface InputArityBounds {
  min: number;
  max: number | null;
}

/**
 * Convert independent input-group multiplicities into the one handle count
 * used by a visual Join. A missing signature keeps the legacy editor default.
 */
export function getInputArityBounds(
  signature?: { readonly inputs: readonly { readonly lower: number; readonly upper: number | null }[] },
): InputArityBounds {
  if (!signature) return { min: 2, max: null };

  let min = 0;
  let max = 0;
  let unbounded = false;
  for (const group of signature.inputs) {
    min += group.lower;
    if (group.upper === null) unbounded = true;
    else max += group.upper;
  }
  return { min, max: unbounded ? null : max };
}

// ── Snapshots ───────────────────────────────────
export interface DiagramCoreSnapshot {
  nodes: Node[];
  edges: Edge[];
  layoutDirection: LayoutDirection;
}

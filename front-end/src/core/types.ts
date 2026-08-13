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

// ── Snapshots ───────────────────────────────────
export interface DiagramCoreSnapshot {
  nodes: Node[];
  edges: Edge[];
  layoutDirection: LayoutDirection;
}

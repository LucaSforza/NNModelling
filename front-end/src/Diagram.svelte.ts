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

// front-end/src/Diagram.svelte.ts
// Thin Svelte wrapper around DiagramCore.
// Adds $state.raw reactivity for Svelte 5.

import { type Node, type Edge } from "@xyflow/svelte";
import { DiagramCore } from "./core/DiagramCore";
import type { LayoutDirection } from "./layout/autoLayout";
import type { GraphInferenceResult } from "./type-system/graph/types";
import { EditorTypeSystemRuntime } from "./type-system/editor-runtime";
import type { ActivePackageMetadata } from "./type-system/host";

export const DIAGRAM_CONTEXT_KEY = Symbol("diagram-context");

export class Diagram extends DiagramCore {
  public nodes: Node[] = $state.raw<Node[]>([]);
  public edges: Edge[] = $state.raw<Edge[]>([]);
  private reactiveLayoutDirection: LayoutDirection = $state("vertical");
  /** Sole editor inference result; it is always package-engine data. */
  public typeResult: GraphInferenceResult | null = $state.raw(null);
  public packageCatalog: ActivePackageMetadata[] = $state.raw([]);
  private packageTypeRuntime: EditorTypeSystemRuntime | null = null;

  public override get layoutDirection(): LayoutDirection {
    return this.reactiveLayoutDirection;
  }

  public override set layoutDirection(value: LayoutDirection) {
    this.reactiveLayoutDirection = value;
  }

  constructor() {
    super();
    // Clear the undo snapshot captured during auto-spawn of Input node —
    // the initial Input should not be undoable.
    this._undoStack = [];
    this._redoStack = [];

    // Force Svelte 5 reactivity when the Core state is mutated via RPC.
    // The subscription is synchronous: typeResult is refreshed before the
    // RPC handler returns.
    this.onGraphChanged(() => {
      this.nodes = [...this.nodes];
      this.edges = [...this.edges];
      if (this.packageTypeRuntime) this.refreshTypes();
    });

    this.refreshTypes();
    void this.initializePackageTypes();
  }

  /** Recompute tensor annotations and diagnostics for the current graph. */
  public refreshTypes(): GraphInferenceResult {
    if (!this.packageTypeRuntime) {
      const result: GraphInferenceResult = {
        nodes: new Map(), order: [], terminals: [], complete: false,
      };
      this.typeResult = result;
      return result;
    }
    const result = this.packageTypeRuntime.infer({ nodes: this.nodes, edges: this.edges });
    this.typeResult = result;
    return result;
  }

  /** Presentation docking is intentionally limited to ordinary layer nodes. */
  public isLayerNode(node: Node): boolean {
    const identity = node.data?.package as { id?: unknown; version?: unknown } | undefined;
    if (typeof identity?.id !== "string" || typeof identity.version !== "string") return false;
    return this.packageCatalog.some((metadata) => (
      metadata.id === identity.id &&
      metadata.version === identity.version &&
      metadata.definition.kind === "layer"
    ));
  }

  private async initializePackageTypes(): Promise<void> {
    try {
      this.packageTypeRuntime = await EditorTypeSystemRuntime.create();
      this.packageCatalog = this.packageTypeRuntime.packages();
      if (this.nodes.length === 0) {
        const input = this.packageCatalog.find((metadata) => metadata.definition.kind === "input");
        if (input) {
          const centerX = (typeof window !== "undefined" ? window.innerWidth : 1024) / 2 - 15;
          this.addPackageNode(
            { id: input.id, version: input.version, name: input.definition.name },
            input.definition.kind,
            centerX,
            50,
            { params: Object.fromEntries(Object.entries(input.definition.parameters).flatMap(([key, definition]) =>
              definition.default === undefined ? [] : [[key, structuredClone(definition.default)]])) },
          );
          this._undoStack = [];
          this._redoStack = [];
        }
      }
      this.refreshTypes();
    } catch (error) {
      console.error("[Diagram] package type-system initialization failed:", error);
    }
  }
}

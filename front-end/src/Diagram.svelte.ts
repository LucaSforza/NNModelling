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
import { StereotypeCore } from "./core/StereotypeCore";
import { TypeEngine } from "./conversion/typeEngine";
import type { TypeResult } from "./conversion/tensortypes";

export const DIAGRAM_CONTEXT_KEY = Symbol("diagram-context");

export class Diagram extends DiagramCore {
  public nodes: Node[] = $state.raw<Node[]>([]);
  public edges: Edge[] = $state.raw<Edge[]>([]);
  public stereotypes = $state.raw<StereotypeCore[]>([]);
  public typeResult: TypeResult | null = $state.raw(null);

  constructor() {
    super();
    this.initStereotypes(StereotypeCore.loadFromDirectory());
    const inputStereotype = this.stereotypes.find(s => s.isInput);
    if (inputStereotype && this.nodes.length === 0) {
      const centerX = (typeof window !== "undefined" ? window.innerWidth : 1024) / 2 - 15;
      this.addModule(inputStereotype, centerX, 50);
    }
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
      this.refreshTypes();
    });

    this.refreshTypes();
  }

  /** Recompute tensor annotations and diagnostics for the current graph. */
  public refreshTypes(): TypeResult {
    const result = TypeEngine.infer(this);
    this.typeResult = result;
    return result;
  }

  /**
   * Replace the active stereotype catalog at runtime (built-in plus project
   * stereotypes) and refresh type inference. Used by project restore after
   * the catalog has been validated atomically.
   */
  public setStereotypes(stereotypes: StereotypeCore[]): void {
    this.initStereotypes(stereotypes);
    this.refreshTypes();
  }
}

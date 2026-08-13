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

// front-end/src/core/DiagramCore.ts
// Pure TypeScript business logic — no Svelte dependencies.
// Extracted from Diagram.svelte.ts with:
//   - $state.raw → plain arrays
//   - Dedicated synchronous graph-change subscription (onGraphChanged)
//   - New methods: addEdge, removeEdge, reconnectEdge, moveNode, moveNodes,
//     getSnapshot, restoreSnapshot, initStereotypes, selectNodes, clearSelection,
//     getSelectedNodes, getSelectedEdges

import { type Node, type Edge } from "@xyflow/svelte";
import { StereotypeCore } from "./StereotypeCore";
import { checkValidConnection as coreCheckValidConnection } from "./validation";
import { validateContainmentGraph } from "./containment";
import { computeAutoLayout, type LayoutDirection } from "../layout/autoLayout";
import type { DiagramCoreSnapshot, NodeConfig, JoinNodeConfig } from "./types";

/**
 * Deep equality for JSON-comparable parameter objects ({ value, position }
 * wrappers and nested plain objects/arrays). Arrays are distinguished from
 * plain objects so `["a","b"]` never compares equal to `{ 0:"a", 1:"b" }`.
 * Used to detect no-op updates before undo capture and graph notification.
 */
function sameParams(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!sameParams((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false;
    }
  }
  return true;
}

function normalizedLayoutDirection(value: unknown): LayoutDirection {
  return value === "horizontal" ? "horizontal" : "vertical";
}

/**
 * Compare only the state automatic layout is allowed to change. The pure
 * engine preserves every other node field, so identity ordering, position,
 * visible dimensions and stored expanded subflow dimensions completely
 * describe whether applying its result would be observable.
 */
function sameLayoutGeometry(current: readonly Node[], next: readonly Node[]): boolean {
  if (current.length !== next.length) return false;
  return current.every((node, index) => {
    const candidate = next[index];
    return candidate?.id === node.id &&
      candidate.position.x === node.position.x &&
      candidate.position.y === node.position.y &&
      candidate.width === node.width &&
      candidate.height === node.height &&
      candidate.data?.oldWidth === node.data?.oldWidth &&
      candidate.data?.oldHeight === node.data?.oldHeight;
  });
}

export class DiagramCore {
  public stereotypes!: StereotypeCore[];

  // nodes/edges are declared but NOT initialized with `= []` here.
  // Diagram.svelte.ts overrides them with $state.raw reactive arrays.
  // Using `!` (definite assignment assertion) tells TS they'll be set
  // before use (by the Diagram constructor chain calling initStereotypes).
  declare public nodes: Node[];
  declare public edges: Edge[];
  declare public layoutDirection: LayoutDirection;

  private graphChangeHandlers = new Set<() => void>();
  private _notifying = false;

  constructor() {
    // NOTE: nodes and edges are NOT initialized here.
    // The Diagram subclass initializes them with $state.raw.
    // When used standalone (MCP server), call initStereotypes() then
    // manually set nodes/edges before any operations.
    this.layoutDirection = "vertical";
  }

  // ── Reentrancy guard ────────────────────────────────────────────

  /**
   * Reject any graph mutation issued while graph-change listeners are being
   * synchronously notified. Centralized in the undo-capture path (plus
   * explicit guards on undo/redo/restoreSnapshot, which bypass capture): a
   * listener that attempts to mutate is reported by notifyGraphChanged()
   * (which catches and logs the error), so the already-applied mutation/RPC
   * still succeeds and no recursion occurs.
   */
  private _assertNotNotifying(): void {
    if (this._notifying) {
      throw new Error("Graph mutation attempted during graph-change notification");
    }
  }

  // ── Graph change subscription ────────────────────────────────────

  /**
   * Subscribe to graph changes. The handler is invoked synchronously once
   * after every successful public mutation (add/update/delete/move/edge
   * operations, undo/redo, snapshot restore, reset and import). Rejected
   * connections and no-op operations do not notify. Returns an unsubscribe
   * function; unsubscribing is safe even from inside a handler.
   */
  public onGraphChanged(handler: () => void): () => void {
    this.graphChangeHandlers.add(handler);
    return () => {
      this.graphChangeHandlers.delete(handler);
    };
  }

  /**
   * Synchronously notify graph-change subscribers (snapshot iteration).
   * While dispatching, the reentrancy guard is active: a listener that tries
   * to mutate the graph is rejected before any mutation/undo capture, logged
   * locally, and does not stop peer listeners or turn an already-applied
   * mutation into an RPC error.
   */
  protected notifyGraphChanged(): void {
    this._notifying = true;
    try {
      for (const handler of [...this.graphChangeHandlers]) {
        try {
          handler();
        } catch (error) {
          console.error("[DiagramCore] graph-change listener error:", error);
        }
      }
    } finally {
      this._notifying = false;
    }
  }

  // ── Undo/Redo ──────────────────────────────────────────────────
  protected _undoStack: DiagramCoreSnapshot[] = [];
  protected _redoStack: DiagramCoreSnapshot[] = [];
  private _captureEnabled = true;

  private _captureUndoState(): void {
    this._assertNotNotifying();
    if (!this._captureEnabled) return;
    this._undoStack.push(this.getSnapshot());
    // Limit stack size to prevent memory issues
    if (this._undoStack.length > 50) this._undoStack.shift();
    // New action clears redo history
    this._redoStack = [];
  }

  /** Undo the last mutation. Returns true if an undo was performed. */
  public undo(): boolean {
    this._assertNotNotifying();
    if (this._undoStack.length === 0) return false;
    const previousCapture = this._captureEnabled;
    this._captureEnabled = false;
    try {
      this._redoStack.push(this.getSnapshot());
      this.restoreSnapshot(this._undoStack.pop()!);
    } finally {
      this._captureEnabled = previousCapture;
    }
    return true;
  }

  /** Redo the last undone mutation. Returns true if a redo was performed. */
  public redo(): boolean {
    this._assertNotNotifying();
    if (this._redoStack.length === 0) return false;
    const previousCapture = this._captureEnabled;
    this._captureEnabled = false;
    try {
      this._undoStack.push(this.getSnapshot());
      this.restoreSnapshot(this._redoStack.pop()!);
    } finally {
      this._captureEnabled = previousCapture;
    }
    return true;
  }

  /** Inject stereotypes (called by Diagram wrapper or MCP server after construction). */
  public initStereotypes(stereotypes: StereotypeCore[]): void {
    this.stereotypes = stereotypes;
  }

  public getNodeById(id: string): Node | undefined {
    return this.nodes.find(n => n.id === id);
  }

  public getChilds(id: string): Node[] {
    const childsIds = this.edges.filter(e => e.source === id).map(e => e.target);
    return this.nodes.filter(n => childsIds.find(c_id => c_id === n.id));
  }

  public getParents(id: string): Node[] {
    const parentsIds = this.edges.filter(e => e.target === id).map(e => e.source);
    return this.nodes.filter(n => parentsIds.find(c_id => c_id === n.id));
  }

  public getStereotype(name: string): StereotypeCore | undefined {
    return this.stereotypes.find(s => s.name === name);
  }

  public addModule(
    stereotype: StereotypeCore,
    x: number,
    y: number,
    customConfig?: { name?: string; color?: string; width?: number; height?: number; params?: any; parentId?: string }
  ) {
    this._captureUndoState();
    // 1. Name logic: if user provided a name use it, otherwise auto-generate (e.g. Tanh_0)
    let finalName = customConfig?.name;

    if (!finalName || finalName.trim() === "") {
      let counter = 0;
      while (this.nodes.some(n => n.data.name === `${stereotype.name}_${counter}`)) {
        counter++;
      }
      finalName = `${stereotype.name}_${counter}`;
    }

    // 2. Create the node merging stereotype data with form data
    const isInput = stereotype.isInput;
    const w = isInput ? 30 : (customConfig?.width || stereotype.view?.width || 140);
    const h = isInput ? 30 : (customConfig?.height || stereotype.view?.height || 60);

    const newNode: Node = {
      id: crypto.randomUUID(),
      type: 'custom',
      position: { x, y },
      width: w,
      height: h,
      parentId: customConfig?.parentId,
      data: {
        stereotype: stereotype.name,
        name: finalName,
        color: customConfig?.color || stereotype.view?.color || '#ffffff',
        params: this._mergeNodeParams(stereotype, customConfig?.params),
        isInput: isInput,
        isLoss: stereotype.isLoss,
      }
    };
    // 3. Add the node to state
    this.nodes = [...this.nodes, newNode];

    this.notifyGraphChanged();
  }

  public addJoinNode(
    stereotype: StereotypeCore,
    x: number,
    y: number,
    config?: { name?: string; inputsCount?: number; color?: string; params?: any; parentId?: string }
  ) {
    this._captureUndoState();
    const id = `join_${crypto.randomUUID()}`;

    const newJoinNode: Node = {
      id,
      type: "join",
      position: { x, y },
      parentId: config?.parentId,
      data: {
        stereotype: stereotype.name,
        name: stereotype.name,
        inputsCount: config?.inputsCount || 2,
        color: config?.color || stereotype.view?.color || "#333",
        params: this._mergeNodeParams(stereotype, config?.params)
      }
    };

    this.nodes = [...this.nodes, newJoinNode];

    this.notifyGraphChanged();
  }

  /**
   * Create a subflow node. Accepts an optional label applied during creation,
   * producing exactly one undo snapshot and one graph notification. Returns
   * the created node.
   */
  public addSubGraph(
    x: number,
    y: number,
    label?: string,
    config?: {
      stereotype?: StereotypeCore;
      name?: string;
      color?: string;
      width?: number;
      height?: number;
      params?: Record<string, string | { value: string; position?: string }>;
      parentId?: string;
    },
  ): Node {
    this._captureUndoState();
    const id = `subflow_${Date.now()}`;
    const stereotype = config?.stereotype;
    const finalLabel = config?.name ?? label ?? stereotype?.name ?? id;
    const width = config?.width ?? stereotype?.view?.width ?? 400;
    const height = config?.height ?? stereotype?.view?.height ?? 300;
    const newSubgraph: Node = {
      id,
      type: "subflow",
      position: { x, y },
      parentId: config?.parentId,
      data: {
        name: finalLabel,
        label: finalLabel,
        ...(stereotype ? {
          stereotype: stereotype.name,
          color: config?.color ?? stereotype.view?.color ?? "#ffffff",
          params: this._mergeNodeParams(stereotype, config?.params),
          isSubFlow: true,
        } : {}),
        isCollapsed: false,
        oldWidth: width,
        oldHeight: height,
        // Dimensions are saved at collapse time in toggleSubflow.
      },
      width,
      height,
    };
    this.nodes = [...this.nodes, newSubgraph];

    this.notifyGraphChanged();
    return newSubgraph;
  }

  public updateModule(
    id: string,
    config: { name?: string; label?: string; color?: string; width?: number; height?: number; params?: any; stereotype?: string }
  ) {
    const node = this.nodes.find(n => n.id === id);
    if (!node) return; // no-op: unknown node

    // Semantic no-op: skip undo capture + notification when nothing changes.
    const nextParams = config.params !== undefined
      ? JSON.parse(JSON.stringify(config.params))
      : node.data.params;
    // Normalize existing params safely: fresh subflows have no params object
    // until the sidebar assigns a stereotype (JSON.parse(undefined) throws).
    const existingParams = node.data.params === undefined ? undefined : JSON.parse(JSON.stringify(node.data.params));
    const nameChanged = config.name !== undefined && config.name !== node.data.name;
    const labelChanged = config.label !== undefined && config.label !== node.data.label;
    const colorChanged = config.color !== undefined && config.color !== node.data.color;
    const stereotypeChanged = config.stereotype !== undefined && config.stereotype !== node.data.stereotype;
    const widthChanged = config.width !== undefined && config.width !== node.width;
    const heightChanged = config.height !== undefined && config.height !== node.height;
    const paramsChanged = config.params !== undefined && !sameParams(
      existingParams,
      nextParams,
    );
    if (!nameChanged && !labelChanged && !colorChanged && !stereotypeChanged &&
        !widthChanged && !heightChanged && !paramsChanged) {
      return;
    }

    this._captureUndoState();

    this.nodes = this.nodes.map(node => {
      if (node.id === id) {
        return {
          ...node,
          width: config.width ?? node.width,
          height: config.height ?? node.height,
          data: {
            ...node.data,
            name: config.name ?? node.data.name,
            label: config.label ?? node.data.label,
            color: config.color ?? node.data.color,
            stereotype: config.stereotype ?? node.data.stereotype,
            params: config.params !== undefined ? JSON.parse(JSON.stringify(config.params)) : node.data.params,
            oldWidth: config.width ?? node.data.oldWidth,
            oldHeight: config.height ?? node.data.oldHeight,
          }
        };
      }
      return node;
    });

    this.notifyGraphChanged();
  }

  public deleteNode(id: string) {
    this.deleteNodes([id]);
  }

  public deleteNodes(ids: string[]) {
    if (ids.length === 0) return; // no-op: empty selection
    const targetIds = ids.filter(id => this.nodes.some(n => n.id === id));
    if (targetIds.length === 0) return; // no-op: no matching nodes
    this._captureUndoState();
    // 1. Use a Set for fast lookups and a Map of ALL nodes before deletion
    const nodesToDelete = new Set(targetIds);
    const allNodesMap = new Map(this.nodes.map(n => [n.id, n]));

    // 2. Filter out deleted nodes and recompute ancestry
    this.nodes = this.nodes
      .filter((n) => !nodesToDelete.has(n.id))
      .map((n) => {
        if (!n.parentId || !nodesToDelete.has(n.parentId)) {
          return n;
        }

        // The direct parent was deleted! Walk up the ancestor chain.
        let currentAncestorId: string | undefined = n.parentId;
        let accumulatedX = n.position.x;
        let accumulatedY = n.position.y;

        while (currentAncestorId && nodesToDelete.has(currentAncestorId)) {
          const deadAncestor = allNodesMap.get(currentAncestorId);
          if (!deadAncestor) break;

          accumulatedX += deadAncestor.position.x;
          accumulatedY += deadAncestor.position.y;

          currentAncestorId = deadAncestor.parentId;
        }

        return {
          ...n,
          parentId: currentAncestorId,
          position: {
            x: accumulatedX,
            y: accumulatedY,
          },
        };
      });

    // 3. Clean up edges connected to deleted nodes
    this.edges = this.edges.filter(
      (e) => !nodesToDelete.has(e.source) && !nodesToDelete.has(e.target)
    );

    this.notifyGraphChanged();
  }

  public deleteEdges(edgesIds: string[]) {
    if (edgesIds.length === 0) return; // no-op: empty selection
    if (!edgesIds.some(id => this.edges.some(e => e.id == id))) return; // no-op: no matches
    this._captureUndoState();
    this.edges = this.edges.filter((e) => edgesIds.find(id => id == e.id) === undefined);
    this.notifyGraphChanged();
  }

  public deleteEdge(edgeId: string) {
    if (!this.edges.some(e => e.id === edgeId)) return; // no-op: unknown edge
    this._captureUndoState();
    this.edges = this.edges.filter((e) => e.id !== edgeId);
    this.notifyGraphChanged();
  }

  public toggleSubflow(parentId: string, willCollapse: boolean) {
    const parent = this.nodes.find(n => n.id === parentId);
    if (!parent || parent.type !== "subflow") return; // no-op: not a subflow
    if (parent.data?.isCollapsed === willCollapse) return; // no-op: already in state
    this._captureUndoState();
    this._toggleSubflowRecursive(parentId, willCollapse);
    this.notifyGraphChanged();
  }

  private _toggleSubflowRecursive(parentId: string, willCollapse: boolean) {
    for (const child of this.nodes.filter(n => n.parentId === parentId)) {
      if (child.type === "subflow") {
        this._toggleSubflowRecursive(child.id, willCollapse);
      }
    }

    this.nodes = this.nodes.map((node) => {
      if (node.parentId === parentId) {
        return { ...node, hidden: willCollapse };
      }

      if (node.id === parentId) {
        if (willCollapse) {
          const w = node.width ?? (node.data?.oldWidth as number | undefined) ?? 400;
          const h = node.height ?? (node.data?.oldHeight as number | undefined) ?? 300;
          return {
            ...node,
            width: 250,
            height: 50,
            data: {
              ...node.data,
              oldWidth: w,
              oldHeight: h,
              isCollapsed: true
            }
          } as Node;
        } else {
          return {
            ...node,
            width: (node.data?.oldWidth as number | undefined) ?? 400,
            height: (node.data?.oldHeight as number | undefined) ?? 300,
            data: {
              ...node.data,
              isCollapsed: false
            }
          } as Node;
        }
      }

      return node;
    });

    const childNodeIds = this.nodes
      .filter((node) => node.parentId === parentId)
      .map((node) => node.id);

    this.edges = this.edges.map((edge) => {
      const isConnectedToChild = childNodeIds.includes(edge.source) || childNodeIds.includes(edge.target);

      if (isConnectedToChild) {
        return {
          ...edge,
          hidden: willCollapse
        };
      }

      return edge;
    });
  }

  // ── Selection ──────────────────────────────────────────────────

  public selectNodes(ids: string[]): void {
    this.nodes = this.nodes.map(n => ({
      ...n,
      selected: ids.includes(n.id),
    }));
  }

  public clearSelection(): void {
    this.nodes = this.nodes.map(n => ({ ...n, selected: false }));
    this.edges = this.edges.map(e => ({ ...e, selected: false }));
  }

  public getSelectedNodes(): Node[] {
    return this.nodes.filter(n => n.selected);
  }

  public getSelectedEdges(): Edge[] {
    return this.edges.filter(e => e.selected);
  }

  // ── Edges (create / remove / reconnect) ───────────────────────

  public addEdge(
    source: string,
    target: string,
    sourceHandle: string = "out",
    targetHandle: string = "in"
  ): Edge {
    // Validate before capturing undo state — don't waste an undo slot on a rejected connection
    const validation = coreCheckValidConnection(
      this.edges,
      source,
      target,
      sourceHandle,
      targetHandle,
      this.nodes,
    );
    if (!validation.valid) {
      throw new Error(validation.reason);
    }
    this._captureUndoState();

    const newEdge: Edge = {
      id: `edge_${crypto.randomUUID()}`,
      source,
      target,
      sourceHandle,
      targetHandle,
    };

    this.edges = [...this.edges, newEdge];
    this.notifyGraphChanged();

    return newEdge;
  }

  public removeEdge(source: string, target: string, targetHandle?: string): void {
    const removedEdges = this.edges.filter(e =>
      e.source === source &&
      e.target === target &&
      (targetHandle === undefined || e.targetHandle === targetHandle)
    );
    if (removedEdges.length === 0) return; // no-op: no matching edge
    this._captureUndoState();

    this.edges = this.edges.filter(e => !removedEdges.some(r => r.id === e.id));

    this.notifyGraphChanged();
  }

  public reconnectEdge(
    edgeId: string,
    newSource?: string,
    newTarget?: string,
    newSourceHandle?: string,
    newTargetHandle?: string
  ): void {
    const edge = this.edges.find(e => e.id === edgeId);
    if (!edge) return; // no-op: unknown edge
    const source = newSource ?? edge.source;
    const target = newTarget ?? edge.target;
    const sourceHandle = newSourceHandle ?? edge.sourceHandle;
    const targetHandle = newTargetHandle ?? edge.targetHandle;
    // no-op: equivalent reconnect (no field actually changes)
    if (source === edge.source && target === edge.target &&
        sourceHandle === edge.sourceHandle && targetHandle === edge.targetHandle) {
      return;
    }
    // Validate against the replacement graph, excluding the edge being
    // reconnected so its own target handle does not count as occupied.
    const validation = coreCheckValidConnection(
      this.edges.filter((candidate) => candidate.id !== edgeId),
      source,
      target,
      sourceHandle ?? undefined,
      targetHandle ?? undefined,
      this.nodes,
    );
    if (!validation.valid) {
      throw new Error(validation.reason);
    }
    this._captureUndoState();
    this.edges = this.edges.map(e => {
      if (e.id === edgeId) {
        return { ...e, source, target, sourceHandle, targetHandle };
      }
      return e;
    });

    this.notifyGraphChanged();
  }

  /**
   * Duplicate the given nodes plus the edges between them as one atomic graph
   * operation. Every source node and stereotype is prevalidated before any
   * mutation; all copies are constructed off-state, then exactly one undo
   * capture, one array replacement and one notification are performed.
   * Subflow nodes are skipped (not an error). Returns the mapping of
   * originalId -> newId.
   */
  public duplicateNodes(
    nodeIds: string[],
    offset: { x: number; y: number } = { x: 50, y: 50 },
  ): Array<{ originalId: string; newId: string }> {
    // Normalize to unique IDs preserving first-occurrence order before any
    // prevalidation, subflow filtering, construction, edge selection or
    // returned mapping. Repeating an ID must create exactly one copy.
    const uniqueIds: string[] = [];
    const seen = new Set<string>();
    for (const id of nodeIds) {
      if (!seen.has(id)) {
        seen.add(id);
        uniqueIds.push(id);
      }
    }

    // Prevalidate every source node and its stereotype before mutating.
    const originals: Array<{ node: Node; stereo: StereotypeCore }> = [];
    for (const id of uniqueIds) {
      const node = this.getNodeById(id);
      if (!node) throw new Error(`Node not found: ${id}`);
      if (node.type === "subflow") continue; // skipped, not an error
      const nd = node.data as Record<string, unknown>;
      const stereo = this.getStereotype(nd.stereotype as string);
      if (!stereo) throw new Error(`Stereotype not found for node ${id}`);
      originals.push({ node, stereo });
    }

    // No-op: nothing to duplicate (empty selection or only subflows).
    if (originals.length === 0) return [];

    // Edges with both endpoints in the selection are copied too.
    const edgesBetweenSelected = this.edges.filter(
      (e) => uniqueIds.includes(e.source) && uniqueIds.includes(e.target),
    );

    // Construct every copy off-state (no capture/notify yet). The final node
    // id is decided first so oldToNew, the created node and the copied edges
    // all reference the same id (joins are prefixed `join_`, matching the
    // established addJoinNode id scheme).
    const oldToNew = new Map<string, string>();
    const newNodes: Node[] = [];
    for (const { node, stereo } of originals) {
      const nd = node.data as Record<string, unknown>;
      const isJoin = node.type === "join" || stereo.isJoin;
      const rawId = crypto.randomUUID();
      const finalId = isJoin ? `join_${rawId}` : rawId;
      oldToNew.set(node.id, finalId);
      const newPos = {
        x: node.position.x + offset.x,
        y: node.position.y + offset.y,
      };
      const sharedParams = nd.params as
        | Record<string, string | { value: string; position?: string }>
        | undefined;
      if (isJoin) {
        newNodes.push({
          id: finalId,
          type: "join",
          position: newPos,
          parentId: node.parentId,
          data: {
            stereotype: stereo.name,
            name: stereo.name,
            inputsCount: (nd.inputsCount as number | undefined) ?? 2,
            color: (nd.color as string | undefined) ?? stereo.view?.color ?? "#333",
            params: this._mergeNodeParams(stereo, sharedParams),
          },
        });
      } else {
        const isInput = stereo.isInput;
        newNodes.push({
          id: finalId,
          type: "custom",
          position: newPos,
          width: node.width ?? stereo.view?.width ?? 140,
          height: node.height ?? stereo.view?.height ?? 60,
          parentId: node.parentId,
          data: {
            stereotype: stereo.name,
            name: (nd.name as string | undefined) ?? `${stereo.name}_copy`,
            color: (nd.color as string | undefined) ?? stereo.view?.color ?? "#ffffff",
            params: this._mergeNodeParams(stereo, sharedParams),
            isInput,
            isLoss: stereo.isLoss,
          },
        });
      }
    }

    const newEdges: Edge[] = [];
    for (const edge of edgesBetweenSelected) {
      const newSource = oldToNew.get(edge.source);
      const newTarget = oldToNew.get(edge.target);
      if (newSource && newTarget) {
        newEdges.push({
          id: `edge_${crypto.randomUUID()}`,
          source: newSource,
          target: newTarget,
          sourceHandle: edge.sourceHandle ?? "out",
          targetHandle: edge.targetHandle ?? "in",
        });
      }
    }

    // One atomic operation: one capture, one array replacement, one notify.
    this._captureUndoState();
    this.nodes = [...this.nodes, ...newNodes];
    this.edges = [...this.edges, ...newEdges];
    this.notifyGraphChanged();

    return [...oldToNew].map(([originalId, newId]) => ({ originalId, newId }));
  }

  // ── Position / Movement ──────────────────────────────────────

  public moveNode(id: string, x: number, y: number): void {
    const node = this.nodes.find(n => n.id === id);
    if (!node) return; // no-op: unknown node
    if (node.position.x === x && node.position.y === y) return; // no-op: same position
    this._captureUndoState();
    this.nodes = this.nodes.map(n =>
      n.id === id ? { ...n, position: { x, y } } : n
    );
    this.notifyGraphChanged();
  }

  public moveNodes(positions: Array<{ id: string; x: number; y: number }>): void {
    if (positions.length === 0) return; // no-op: empty selection
    const posMap = new Map(positions.map(p => [p.id, { x: p.x, y: p.y }]));
    // no-op: no node actually changes position
    let moved = false;
    for (const n of this.nodes) {
      const pos = posMap.get(n.id);
      if (pos && (n.position.x !== pos.x || n.position.y !== pos.y)) {
        moved = true;
        break;
      }
    }
    if (!moved) return;
    this._captureUndoState();
    this.nodes = this.nodes.map(n => {
      const pos = posMap.get(n.id);
      return pos ? { ...n, position: pos } : n;
    });
    this.notifyGraphChanged();
  }

  /**
   * Arrange the complete compound diagram as one atomic graph mutation.
   * Validation and pure layout computation finish before undo capture, so a
   * rejected graph cannot change state or history. Returns whether state was
   * changed; an already-identical layout is a no-op.
   */
  public autoLayout(direction: LayoutDirection): boolean {
    if (direction !== "vertical" && direction !== "horizontal") {
      throw new Error(`Unsupported layout direction '${String(direction)}'`);
    }

    const containment = validateContainmentGraph(this.nodes, this.edges);
    if (!containment.valid) {
      throw new Error(containment.reason);
    }

    const nextNodes = computeAutoLayout(this.nodes, this.edges, direction);
    if (direction === this.layoutDirection && sameLayoutGeometry(this.nodes, nextNodes)) {
      return false;
    }

    this._captureUndoState();
    this.nodes = nextNodes;
    this.layoutDirection = direction;
    this.notifyGraphChanged();
    return true;
  }

  // ── Snapshots ─────────────────────────────────────────────────

  public getSnapshot(): DiagramCoreSnapshot {
    return {
      nodes: [...this.nodes],
      edges: [...this.edges],
      layoutDirection: this.layoutDirection,
    };
  }

  public restoreSnapshot(snapshot: DiagramCoreSnapshot): void {
    this._assertNotNotifying();
    this.nodes = [...snapshot.nodes];
    this.edges = [...snapshot.edges];
    this.layoutDirection = normalizedLayoutDirection(
      (snapshot as DiagramCoreSnapshot & { layoutDirection?: unknown }).layoutDirection,
    );
    this.notifyGraphChanged();
  }

  /**
   * Clear the diagram (reset_diagram RPC). Reassigns fresh arrays so the
   * Svelte reactivity bridge observes the change, captures one undo snapshot
   * (undo restores the previous diagram) and synchronously notifies graph
   * subscribers exactly once. An already-empty diagram is a no-op (zero
   * undo entries, zero notifications).
   */
  public reset(): void {
    if (this.nodes.length === 0 && this.edges.length === 0) return; // no-op
    this._captureUndoState();
    this.nodes = [];
    this.edges = [];
    this.notifyGraphChanged();
  }

  // ── Connection Validation ────────────────────────────────────

  public checkValidConnection(
    source: string,
    target: string,
    sourceHandle?: string,
    targetHandle?: string
  ): boolean {
    const result = coreCheckValidConnection(
      this.edges,
      source,
      target,
      sourceHandle,
      targetHandle,
      this.nodes,
    );
    return result.valid;
  }

  // ── Private Helpers ───────────────────────────────────────────

  private getDefaultParams(stereotype: StereotypeCore): Record<string, { value: string; position?: string }> {
    if (!stereotype.parameters) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(stereotype.parameters).map(([key, paramDef]) => [
        key,
        { value: paramDef.default, position: paramDef.position }
      ])
    );
  }

  /**
   * Merge user-supplied params (plain strings) with stereotype defaults.
   * Always starts with getDefaultParams() output ({ value, position } objects),
   * then overlays each user key as { value: userVal, position: previous?.position }.
   * This ensures stereotype defaults are preserved for keys not in userParams.
   */
  private _mergeNodeParams(
    stereotype: StereotypeCore,
    userParams?: Record<string, string | { value: string; position?: string }>
  ): Record<string, { value: string; position?: string }> {
    const merged = this.getDefaultParams(stereotype);
    if (userParams) {
      for (const [key, value] of Object.entries(userParams)) {
        const existing = merged[key];
        // Handle both formats: plain string (from create_node RPC) and
        // { value } wrapper (from duplicateNodes RPC)
        const innerValue =
          typeof value === 'object' && value !== null && 'value' in value
            ? String((value as { value: string }).value)
            : String(value);
        merged[key] = {
          value: innerValue,
          ...(existing?.position ? { position: existing.position } : {}),
        };
      }
    }
    return merged;
  }

  // ── Serialization ─────────────────────────────────────────────

  public exportToJson(): string {
    const exportData = {
      nodes: this.nodes,
      edges: this.edges,
      layoutDirection: this.layoutDirection,
    };
    return JSON.stringify(exportData, null, 2);
  }

  public importFromJson(jsonString: string): boolean {
    try {
      const parsedData: unknown = JSON.parse(jsonString);
      if (
        !parsedData ||
        typeof parsedData !== "object" ||
        !Array.isArray((parsedData as { nodes?: unknown }).nodes) ||
        !Array.isArray((parsedData as { edges?: unknown }).edges)
      ) {
        throw new Error("Il file JSON non contiene un formato valido (nodi o edges mancanti).");
      }

      const imported = parsedData as {
        nodes: unknown[];
        edges: unknown[];
        layoutDirection?: unknown;
      };
      // Normalize edge handle IDs before validation, but keep the imported
      // graph entirely off-state until containment validation succeeds.
      const normalizedEdges = imported.edges.map((candidate) => {
        if (!candidate || typeof candidate !== "object") return candidate;
        const edge = candidate as Edge;
        return {
          ...edge,
          sourceHandle: edge.sourceHandle || "out",
          targetHandle: edge.targetHandle || "in",
        };
      });
      const containment = validateContainmentGraph(imported.nodes, normalizedEdges);
      if (!containment.valid) {
        throw new Error(containment.reason);
      }
      const importedDirection = normalizedLayoutDirection(imported.layoutDirection);

      this._captureUndoState();

      // No callbacks needed — SubflowNode uses getContext to access diagram.
      this.nodes = imported.nodes as Node[];
      this.edges = normalizedEdges as Edge[];
      this.layoutDirection = importedDirection;
    } catch (error) {
      console.error("Errore durante l'importazione del modello:", error);
      return false;
    }

    this.notifyGraphChanged();
    return true;
  }
}

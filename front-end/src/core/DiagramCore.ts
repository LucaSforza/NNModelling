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
import { checkValidConnection as coreCheckValidConnection } from "./validation";
import { validateContainmentGraph } from "./containment";
import { computeAutoLayout, type LayoutDirection } from "../layout/autoLayout";
import { parseModelManifest, type DiagramCoreSnapshot, type ModelManifest, type NodeConfig, type JoinNodeConfig, type PackageIdentity, type PersistedPackageIdentity } from "./types";
import {
  edgeWithRoutePoints,
  normalizeEditableEdge,
  normalizeRoutePoints,
  routePointsFromData,
  sameRoutePoints,
} from "./edgeRoute";

/** Convert Svelte's reactive proxy payloads into persisted JSON primitives. */
function clonePackageParams(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value) return {};
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function hasPackageIdentity(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const data = (node as { data?: unknown }).data;
  if (!data || typeof data !== "object") return false;
  const pkg = (data as { package?: unknown }).package;
  if (!pkg || typeof pkg !== "object") return false;
  const identity = pkg as Record<string, unknown>;
  return typeof identity.id === "string" &&
    typeof identity.version === "string";
}

/** Legacy parameter wrappers are intentionally rejected, never converted. */
function hasLegacyParameterWrapper(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasLegacyParameterWrapper);
  if (!value || typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(object, "value") &&
      (Object.prototype.hasOwnProperty.call(object, "position") || Object.keys(object).length <= 2)) {
    return true;
  }
  return Object.values(object).some(hasLegacyParameterWrapper);
}

function validatePackageNode(node: unknown): void {
  if (!hasPackageIdentity(node)) {
    throw new Error("Package node rejected: data.package must contain exact id and version");
  }
  const data = (node as { data: Record<string, unknown> }).data;
  if (hasLegacyParameterWrapper(data.params)) {
    throw new Error("Legacy frontend parameters rejected: values must be primitive package values");
  }
}

/** Keep legacy display metadata readable without allowing it to resolve a package. */
function canonicalizePackageNode(node: Node): Node {
  const data = node.data as Record<string, unknown>;
  const packageValue = data.package as Record<string, unknown>;
  const persisted: PersistedPackageIdentity = {
    id: packageValue.id as string,
    version: packageValue.version as string,
  };
  const legacyName = typeof packageValue.name === "string" ? packageValue.name : undefined;
  return {
    ...node,
    data: {
      ...data,
      // Keep the in-memory name for old UI callers. It is stripped by export.
      package: { ...persisted, name: legacyName ?? (typeof data.name === "string" ? data.name : persisted.id) },
      ...(typeof data.name === "string" ? {} : { name: legacyName ?? persisted.id }),
    },
  };
}

function persistedNode(node: Node): Node {
  const data = node.data as Record<string, unknown>;
  const packageValue = data.package;
  if (!packageValue || typeof packageValue !== "object") return node;
  const identity = packageValue as Record<string, unknown>;
  if (typeof identity.id !== "string" || typeof identity.version !== "string") return node;
  return {
    ...node,
    data: {
      ...data,
      package: { id: identity.id, version: identity.version },
    },
  };
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
  // nodes/edges are declared but NOT initialized with `= []` here.
  // Diagram.svelte.ts overrides them with $state.raw reactive arrays.
  // Using `!` (definite assignment assertion) tells TS they'll be set
  // before use (by the Diagram constructor chain calling initStereotypes).
  declare public nodes: Node[];
  declare public edges: Edge[];
  /** Metadata for the currently loaded package-native model. */
  public modelManifest: ModelManifest = {
    schemaVersion: 1,
    id: "model.untitled",
    version: "0.1.0",
    name: "Untitled model",
    customPackages: [],
  };
  private _layoutDirection: LayoutDirection = "vertical";

  public get layoutDirection(): LayoutDirection {
    return this._layoutDirection;
  }

  public set layoutDirection(value: LayoutDirection) {
    this._layoutDirection = value;
  }

  private graphChangeHandlers = new Set<() => void>();
  private _notifying = false;

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

  /** Whether an edge was created by the handle-over-handle docking gesture. */
  public isDockedEdge(edge: Edge): boolean {
    const data = edge.data as { docked?: unknown } | undefined;
    return data?.docked === true;
  }

  /** Create a node backed by a versioned package identity. */
  public addPackageModule(
    identity: PackageIdentity,
    kind: "input" | "layer" | "loss" | "output",
    x: number,
    y: number,
    config?: { name?: string; color?: string; width?: number; height?: number; params?: Record<string, unknown>; parentId?: string; wheelAdapters?: readonly string[] },
  ): Node {
    this._captureUndoState();
    const finalName = config?.name?.trim() || identity.name || identity.id;
    const newNode: Node = {
      id: crypto.randomUUID(),
      type: "custom",
      position: { x, y },
      width: config?.width ?? (kind === "input" ? 30 : 140),
      height: config?.height ?? (kind === "input" ? 30 : 60),
      parentId: config?.parentId,
      data: {
        package: { ...identity, name: identity.name || identity.id },
        name: finalName,
        color: config?.color ?? "#ffffff",
        params: clonePackageParams(config?.params),
        ...(config?.wheelAdapters ? { wheelAdapters: [...config.wheelAdapters] } : {}),
      },
    };
    this.nodes = [...this.nodes, newNode];
    this.notifyGraphChanged();
    return newNode;
  }

  /** Create any package kind from declarative metadata, without package-ID cases. */
  public addPackageNode(
    identity: PackageIdentity,
    kind: "input" | "layer" | "loss" | "join" | "subflow" | "output",
    x: number,
    y: number,
    config?: {
      name?: string;
      color?: string;
      width?: number;
      height?: number;
      params?: Record<string, unknown>;
      inputsCount?: number;
      parentId?: string;
      wheelAdapters?: readonly string[];
    },
  ): Node {
    if (kind === "join") {
      return this.addPackageJoin(identity, x, y, config);
    }
    if (kind === "subflow") {
      return this.addPackageSubflow(identity, x, y, config);
    }
    return this.addPackageModule(identity, kind, x, y, config);
  }

  public addPackageJoin(
    identity: PackageIdentity,
    x: number,
    y: number,
    config?: {
      name?: string;
      color?: string;
      width?: number;
      height?: number;
      params?: Record<string, unknown>;
      inputsCount?: number;
      parentId?: string;
      wheelAdapters?: readonly string[];
    },
  ): Node {
    this._captureUndoState();
    const node: Node = {
      id: `join_${crypto.randomUUID()}`,
      type: "join",
      position: { x, y },
      width: config?.width,
      height: config?.height,
      parentId: config?.parentId,
      data: {
        package: { ...identity, name: identity.name || identity.id },
        name: config?.name?.trim() || identity.name || identity.id,
        color: config?.color ?? "#4779c4",
        params: clonePackageParams(config?.params),
        inputsCount: config?.inputsCount ?? 2,
        ...(config?.wheelAdapters ? { wheelAdapters: [...config.wheelAdapters] } : {}),
      },
    };
    this.nodes = [...this.nodes, node];
    this.notifyGraphChanged();
    return node;
  }

  public addPackageSubflow(
    identity: PackageIdentity,
    x: number,
    y: number,
    config?: {
      name?: string;
      color?: string;
      width?: number;
      height?: number;
      params?: Record<string, unknown>;
      parentId?: string;
      wheelAdapters?: readonly string[];
    },
  ): Node {
    this._captureUndoState();
    const name = config?.name?.trim() || identity.name || identity.id;
    const width = config?.width ?? 180;
    const height = config?.height ?? 100;
    const node: Node = {
      id: `subflow_${crypto.randomUUID()}`,
      type: "subflow",
      position: { x, y },
      width,
      height,
      parentId: config?.parentId,
      data: {
        package: { ...identity, name: identity.name || identity.id },
        name,
        label: name,
        color: config?.color ?? "#4779c4",
        params: clonePackageParams(config?.params),
        isCollapsed: false,
        oldWidth: width,
        oldHeight: height,
        ...(config?.wheelAdapters ? { wheelAdapters: [...config.wheelAdapters] } : {}),
      },
    };
    this.nodes = [...this.nodes, node];
    this.notifyGraphChanged();
    return node;
  }

  /** Update a package node while preserving its exact identity and primitive params. */
  public updatePackageNode(
    id: string,
    identity: PackageIdentity,
    kind: "input" | "layer" | "loss" | "join" | "subflow" | "output",
    config: {
      name?: string;
      color?: string;
      width?: number;
      height?: number;
      params?: Record<string, unknown>;
      inputsCount?: number;
      wheelAdapters?: readonly string[];
    },
  ): void {
    const node = this.nodes.find((candidate) => candidate.id === id);
    if (!node) return;
    if (!identity.id || !identity.version) {
      throw new Error("package identity requires exact id and version");
    }
    if (hasLegacyParameterWrapper(config.params)) {
      throw new Error("package parameters must use primitive values");
    }
    this._captureUndoState();
    this.nodes = this.nodes.map((candidate) => {
      if (candidate.id !== id) return candidate;
      const data = {
        ...candidate.data,
        package: { ...identity, name: identity.name || identity.id },
        name: config.name ?? candidate.data.name,
        label: kind === "subflow" ? (config.name ?? candidate.data.label ?? candidate.data.name) : candidate.data.label,
        color: config.color ?? candidate.data.color,
        params: config.params === undefined ? candidate.data.params : clonePackageParams(config.params),
        ...(config.wheelAdapters === undefined ? {} : { wheelAdapters: [...config.wheelAdapters] }),
        ...(kind === "join" ? { inputsCount: config.inputsCount ?? candidate.data.inputsCount ?? 2 } : {}),
      };
      return {
        ...candidate,
        type: kind === "join" ? "join" : kind === "subflow" ? "subflow" : "custom",
        width: config.width ?? candidate.width,
        height: config.height ?? candidate.height,
        data,
      };
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
    targetHandle: string = "in",
    options: { docked?: boolean } = {},
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
      type: "editable",
      data: {
        route: { points: [] },
        ...(options.docked ? { docked: true } : {}),
      },
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

  /**
   * Set an edge's scope-local bend points atomically. Only finite `{ x, y }`
   * points are accepted; an empty list selects automatic routing. Invalid,
   * unknown and unchanged updates are no-ops and return false.
   */
  public updateEdgeRoute(edgeId: string, points: unknown): boolean {
    const normalizedPoints = normalizeRoutePoints(points);
    if (!normalizedPoints) return false;

    const edge = this.edges.find((candidate) => candidate.id === edgeId);
    if (!edge || sameRoutePoints(routePointsFromData(edge.data), normalizedPoints)) {
      return false;
    }

    this._captureUndoState();
    this.edges = this.edges.map((candidate) => (
      candidate.id === edgeId ? edgeWithRoutePoints(candidate, normalizedPoints) : candidate
    ));
    this.notifyGraphChanged();
    return true;
  }

  /** Clear a manual route and return the edge to automatic routing. */
  public clearEdgeRoute(edgeId: string): boolean {
    return this.updateEdgeRoute(edgeId, []);
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
        return edgeWithRoutePoints({ ...e, source, target, sourceHandle, targetHandle }, []);
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

    // Prevalidate every source node and its package identity before mutating.
    const originals: Node[] = [];
    for (const id of uniqueIds) {
      const node = this.getNodeById(id);
      if (!node) throw new Error(`Node not found: ${id}`);
      validatePackageNode(node);
      originals.push(node);
    }

    // No-op: nothing to duplicate (empty selection or only subflows).
    if (originals.length === 0) return [];

    // Edges with both endpoints in the selection are copied too.
    const edgesBetweenSelected = this.edges.filter(
      (e) => uniqueIds.includes(e.source) && uniqueIds.includes(e.target),
    );

    // Construct every copy off-state (no capture/notify yet). The final node
    // id is decided first so oldToNew, the created node and the copied edges
    // all reference the same id (joins retain their visual prefix).
    const oldToNew = new Map<string, string>();
    const newNodes: Node[] = [];
    for (const node of originals) {
      const nd = node.data as Record<string, unknown>;
      const isJoin = node.type === "join";
      const rawId = crypto.randomUUID();
      const finalId = isJoin ? `join_${rawId}` : rawId;
      oldToNew.set(node.id, finalId);
      const newPos = {
        x: node.position.x + offset.x,
        y: node.position.y + offset.y,
      };
      newNodes.push({
        ...node,
        id: finalId,
        position: newPos,
        data: JSON.parse(JSON.stringify(nd)),
      });
    }

    const newEdges: Edge[] = [];
    for (const edge of edgesBetweenSelected) {
      const newSource = oldToNew.get(edge.source);
      const newTarget = oldToNew.get(edge.target);
      if (newSource && newTarget) {
        newEdges.push(edgeWithRoutePoints({
          id: `edge_${crypto.randomUUID()}`,
          source: newSource,
          target: newTarget,
          sourceHandle: edge.sourceHandle ?? "out",
          targetHandle: edge.targetHandle ?? "in",
        }, routePointsFromData(edge.data)));
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
      // Svelte Flow can supply a valid automatic edge before it has route
      // metadata. Snapshots must still use the canonical explicit empty route
      // so undo/redo changes the renderer's route state in both directions.
      edges: this.edges.map((edge) => normalizeEditableEdge(edge)),
      layoutDirection: this.layoutDirection,
      manifest: structuredClone(this.modelManifest),
    };
  }

  public restoreSnapshot(snapshot: DiagramCoreSnapshot): void {
    this._assertNotNotifying();
    const manifest = parseModelManifest(snapshot.manifest);
    this.nodes = [...snapshot.nodes];
    this.edges = snapshot.edges.map((edge) => normalizeEditableEdge(edge));
    this.layoutDirection = normalizedLayoutDirection(
      (snapshot as DiagramCoreSnapshot & { layoutDirection?: unknown }).layoutDirection,
    );
    this.modelManifest = manifest;
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

  // ── Serialization ─────────────────────────────────────────────

  public exportToJson(): string {
    const exportData = {
      // Display names are definition metadata, not project identity. The
      // explicit projection also keeps reactive proxies out of persistence.
      nodes: this.nodes.map(persistedNode),
      // Persist the canonical edge contract even when a caller constructed a
      // legacy edge directly instead of going through addEdge/import.
      edges: this.edges.map((edge) => normalizeEditableEdge(edge)),
      layoutDirection: this.layoutDirection,
      manifest: this.modelManifest,
    };
    return JSON.stringify(exportData, null, 2);
  }

  /** Parse and validate a project without changing the live graph. */
  public parseProjectJson(jsonString: string): DiagramCoreSnapshot | undefined {
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
        manifest?: unknown;
      };
      const manifest = parseModelManifest(imported.manifest);
      imported.nodes.forEach(validatePackageNode);
      const normalizedNodes = imported.nodes.map((node) => canonicalizePackageNode(node as Node));
      // Normalize edge handle IDs before validation, but keep the imported
      // graph entirely off-state until containment validation succeeds.
      const normalizedEdges = imported.edges.map((candidate) => {
        if (!candidate || typeof candidate !== "object") return candidate;
        const edge = candidate as Edge;
        return normalizeEditableEdge({
          ...edge,
          sourceHandle: edge.sourceHandle || "out",
          targetHandle: edge.targetHandle || "in",
        });
      });
      const containment = validateContainmentGraph(imported.nodes, normalizedEdges);
      if (!containment.valid) {
        throw new Error(containment.reason);
      }
      const importedDirection = normalizedLayoutDirection(imported.layoutDirection);
      return {
        nodes: normalizedNodes,
        edges: normalizedEdges as Edge[],
        layoutDirection: importedDirection,
        manifest,
      };
    } catch (error) {
      console.error("Errore durante l'importazione del modello:", error);
      return undefined;
    }
  }

  /** Commit one already parsed project through the sole graph authority. */
  public commitProject(snapshot: DiagramCoreSnapshot): boolean {
    this._assertNotNotifying();
    const manifest = parseModelManifest(snapshot.manifest);
    this._captureUndoState();
    this.nodes = [...snapshot.nodes];
    this.edges = snapshot.edges.map((edge) => normalizeEditableEdge(edge));
    this.layoutDirection = normalizedLayoutDirection(snapshot.layoutDirection);
    this.modelManifest = manifest;
    this.notifyGraphChanged();
    return true;
  }

  /** Synchronous compatibility path; async package reconciliation uses Diagram.importProjectJson. */
  public importFromJson(jsonString: string): boolean {
    const parsed = this.parseProjectJson(jsonString);
    return parsed === undefined ? false : this.commitProject(parsed);
  }
}

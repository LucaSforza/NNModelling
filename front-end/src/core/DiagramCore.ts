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
//   - EventBus integration (emit after every mutation)
//   - New methods: addEdge, removeEdge, reconnectEdge, moveNode, moveNodes,
//     getSnapshot, restoreSnapshot, initStereotypes, selectNodes, clearSelection,
//     getSelectedNodes, getSelectedEdges

import { type Node, type Edge } from "@xyflow/svelte";
import { StereotypeCore } from "./StereotypeCore";
import { EventBus } from "./EventBus";
import { checkValidConnection as coreCheckValidConnection } from "./validation";
import type { DiagramCoreSnapshot, NodeConfig, JoinNodeConfig } from "./types";

export class DiagramCore {
  public stereotypes!: StereotypeCore[];
  public readonly events: EventBus;

  // nodes/edges are declared but NOT initialized with `= []` here.
  // Diagram.svelte.ts overrides them with $state.raw reactive arrays.
  // Using `!` (definite assignment assertion) tells TS they'll be set
  // before use (by the Diagram constructor chain calling initStereotypes).
  declare public nodes: Node[];
  declare public edges: Edge[];

  constructor() {
    // NOTE: nodes and edges are NOT initialized here.
    // The Diagram subclass initializes them with $state.raw.
    // When used standalone (MCP server), call initStereotypes() then
    // manually set nodes/edges before any operations.
    this.events = new EventBus();
  }

  // ── Undo/Redo ──────────────────────────────────────────────────
  protected _undoStack: DiagramCoreSnapshot[] = [];
  protected _redoStack: DiagramCoreSnapshot[] = [];
  private _captureEnabled = true;

  private _captureUndoState(): void {
    if (!this._captureEnabled) return;
    this._undoStack.push(this.getSnapshot());
    // Limit stack size to prevent memory issues
    if (this._undoStack.length > 50) this._undoStack.shift();
    // New action clears redo history
    this._redoStack = [];
  }

  /** Undo the last mutation. Returns true if an undo was performed. */
  public undo(): boolean {
    if (this._undoStack.length === 0) return false;
    this._captureEnabled = false;
    this._redoStack.push(this.getSnapshot());
    this.restoreSnapshot(this._undoStack.pop()!);
    this._captureEnabled = true;
    return true;
  }

  /** Redo the last undone mutation. Returns true if a redo was performed. */
  public redo(): boolean {
    if (this._redoStack.length === 0) return false;
    this._captureEnabled = false;
    this._undoStack.push(this.getSnapshot());
    this.restoreSnapshot(this._redoStack.pop()!);
    this._captureEnabled = true;
    return true;
  }

  /** Inject stereotypes (called by Diagram wrapper or MCP server after construction). */
  public initStereotypes(stereotypes: StereotypeCore[]): void {
    this.stereotypes = stereotypes;
  }

  public getNodeById(id: string): Node | undefined {
    return this.nodes.find(n => n.id === id);
  }

  /**
   * The stereotype category is the semantic source of truth.  `type` and
   * `data.isObservable` are persisted rendering metadata and are checked at
   * import time, but must not turn an ordinary stereotype into an Observable.
   */
  public isObservableNode(node: Node | undefined): boolean {
    if (!node) return false;
    const stereotype = this.getStereotype(String(node.data.stereotype ?? ""));
    return stereotype?.isObservable === true;
  }

  public getChilds(id: string): Node[] {
    const source = this.getNodeById(id);
    const childsIds = this.edges
      .filter((edge) => edge.source === id && !this.isObservableNode(source) && !this.isObservableNode(this.getNodeById(edge.target)))
      .map((edge) => edge.target);
    return this.nodes.filter(n => childsIds.find(c_id => c_id === n.id));
  }

  public getParents(id: string): Node[] {
    const target = this.getNodeById(id);
    const parentsIds = this.edges
      .filter((edge) => edge.target === id && !this.isObservableNode(target) && !this.isObservableNode(this.getNodeById(edge.source)))
      .map((edge) => edge.source);
    return this.nodes.filter(n => parentsIds.find(c_id => c_id === n.id));
  }

  public getStereotype(name: string): StereotypeCore | undefined {
    return this.stereotypes.find(s => s.name === name);
  }

  get layerStereotypes() { return this.stereotypes.filter(s => !s.isJoin); }
  get joinStereotypes() { return this.stereotypes.filter(s => s.isJoin); }

  public addModule(
    stereotype: StereotypeCore,
    x: number,
    y: number,
    customConfig?: { name?: string; color?: string; width?: number; height?: number; params?: Record<string, unknown>; parentId?: string; enabled?: boolean }
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

    const isObservable = stereotype.isObservable;
    const newNode: Node = {
      id: crypto.randomUUID(),
      type: isObservable ? 'observable' : 'custom',
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
        isObservable,
        enabled: customConfig?.enabled ?? true,
      }
    };
    // 3. Add the node to state
    this.nodes = [...this.nodes, newNode];

    this.events.emit("node_created", {
      nodeId: newNode.id,
      name: finalName,
      type: isObservable ? "observable" : "custom",
      stereotype: stereotype.name,
    });
    this.events.emit("graph_changed", {
      nodeCount: this.nodes.length,
      edgeCount: this.edges.length,
    });
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

    this.events.emit("node_created", {
      nodeId: newJoinNode.id,
      name: stereotype.name,
      type: "join",
      stereotype: stereotype.name,
    });
    this.events.emit("graph_changed", {
      nodeCount: this.nodes.length,
      edgeCount: this.edges.length,
    });
  }

  public addSubGraph(x: number, y: number) {
    this._captureUndoState();
    const id = `subflow_${Date.now()}`;
    const newSubgraph: Node = {
      id,
      type: "subflow",
      position: { x, y },
      data: {
        label: `${id}`,
        isCollapsed: false,
        oldWidth: 400,
        oldHeight: 300,
        // Dimensions are saved at collapse time in toggleSubflow.
      },
      width: 400,
      height: 300
    };
    this.nodes = [...this.nodes, newSubgraph];

    this.events.emit("node_created", {
      nodeId: id,
      name: id,
      type: "subflow",
      stereotype: "SubFlow",
    });
    this.events.emit("graph_changed", {
      nodeCount: this.nodes.length,
      edgeCount: this.edges.length,
    });
  }

  public updateModule(
    id: string,
    config: { name?: string; label?: string; color?: string; width?: number; height?: number; params?: Record<string, unknown>; stereotype?: string; enabled?: boolean }
  ) {
    this._captureUndoState();
    const changes: Record<string, unknown> = {};
    if (config.name !== undefined) changes.name = config.name;
    if (config.label !== undefined) changes.label = config.label;
    if (config.color !== undefined) changes.color = config.color;
    if (config.width !== undefined) changes.width = config.width;
    if (config.height !== undefined) changes.height = config.height;
    if (config.params !== undefined) changes.params = config.params;
    if (config.stereotype !== undefined) changes.stereotype = config.stereotype;
    if (config.enabled !== undefined) changes.enabled = config.enabled;

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
            enabled: config.enabled ?? node.data.enabled,
            params: config.params ? JSON.parse(JSON.stringify(config.params)) : node.data.params,
            oldWidth: config.width ?? node.data.oldWidth,
            oldHeight: config.height ?? node.data.oldHeight,
          }
        };
      }
      return node;
    });

    this.events.emit("node_updated", { nodeId: id, changes });
    this.events.emit("graph_changed", {
      nodeCount: this.nodes.length,
      edgeCount: this.edges.length,
    });
  }

  public deleteNode(id: string) {
    this.deleteNodes([id]);
  }

  public deleteNodes(ids: string[]) {
    this._captureUndoState();
    // 1. Use a Set for fast lookups and a Map of ALL nodes before deletion
    const nodesToDelete = new Set(ids);
    const allNodesMap = new Map(this.nodes.map(n => [n.id, n]));

    // Capture edges attached to deleted nodes
    const removedEdges = this.edges.filter(e => nodesToDelete.has(e.source) || nodesToDelete.has(e.target));
    const removedEdgeIds = removedEdges.map(e => e.id);

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

    this.events.emit("node_deleted", { nodeIds: ids, removedEdgeIds });
    if (removedEdgeIds.length > 0) {
      this.events.emit("edge_deleted", { edgeIds: removedEdgeIds });
    }
    this.events.emit("graph_changed", {
      nodeCount: this.nodes.length,
      edgeCount: this.edges.length,
    });
  }

  public deleteEdges(edgesIds: string[]) {
    this._captureUndoState();
    this.edges = this.edges.filter((e) => edgesIds.find(id => id == e.id) === undefined);
    this.events.emit("edge_deleted", { edgeIds: edgesIds });
    this.events.emit("graph_changed", {
      nodeCount: this.nodes.length,
      edgeCount: this.edges.length,
    });
  }

  public deleteEdge(edgeId: string) {
    this._captureUndoState();
    this.edges = this.edges.filter((e) => e.id !== edgeId);
    this.events.emit("edge_deleted", { edgeIds: [edgeId] });
    this.events.emit("graph_changed", {
      nodeCount: this.nodes.length,
      edgeCount: this.edges.length,
    });
  }

  public toggleSubflow(parentId: string, willCollapse: boolean) {
    this._captureUndoState();
    this._toggleSubflowRecursive(parentId, willCollapse);
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

    this.events.emit("subflow_toggled", { nodeId: parentId, collapsed: willCollapse });
    this.events.emit("graph_changed", {
      nodeCount: this.nodes.length,
      edgeCount: this.edges.length,
    });
  }

  // ── Selection ──────────────────────────────────────────────────

  public selectNodes(ids: string[]): void {
    this.nodes = this.nodes.map(n => ({
      ...n,
      selected: ids.includes(n.id),
    }));
    this.events.emit("selection_changed", {
      nodeIds: ids,
      edgeIds: this.getSelectedEdges().map(e => e.id),
    });
  }

  public clearSelection(): void {
    this.nodes = this.nodes.map(n => ({ ...n, selected: false }));
    this.edges = this.edges.map(e => ({ ...e, selected: false }));
    this.events.emit("selection_changed", { nodeIds: [], edgeIds: [] });
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
    if (!this.getNodeById(source) || !this.getNodeById(target)) {
      throw new Error("Cannot connect an edge to a missing node");
    }
    // Validate before capturing undo state — don't waste an undo slot on a rejected connection
    const validation = this.validateConnection(source, target, sourceHandle, targetHandle);
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
    this.events.emit("edge_created", {
      edgeId: newEdge.id,
      source,
      target,
      sourceHandle,
      targetHandle,
    });
    this.events.emit("graph_changed", {
      nodeCount: this.nodes.length,
      edgeCount: this.edges.length,
    });

    return newEdge;
  }

  public removeEdge(source: string, target: string, targetHandle?: string): void {
    this._captureUndoState();
    const removedEdges = this.edges.filter(e =>
      e.source === source &&
      e.target === target &&
      (targetHandle === undefined || e.targetHandle === targetHandle)
    );
    const removedEdgeIds = removedEdges.map(e => e.id);

    this.edges = this.edges.filter(e => !removedEdges.some(r => r.id === e.id));

    this.events.emit("edge_deleted", { edgeIds: removedEdgeIds });
    this.events.emit("graph_changed", {
      nodeCount: this.nodes.length,
      edgeCount: this.edges.length,
    });
  }

  public reconnectEdge(
    edgeId: string,
    newSource?: string,
    newTarget?: string,
    newSourceHandle?: string,
    newTargetHandle?: string
  ): void {
    const currentEdge = this.edges.find((edge) => edge.id === edgeId);
    if (!currentEdge) throw new Error(`Edge not found: ${edgeId}`);
    const nextSource = newSource ?? currentEdge.source;
    const nextTarget = newTarget ?? currentEdge.target;
    const nextSourceHandle = newSourceHandle ?? currentEdge.sourceHandle ?? "out";
    const nextTargetHandle = newTargetHandle ?? currentEdge.targetHandle ?? "in";
    if (!this.getNodeById(nextSource) || !this.getNodeById(nextTarget)) {
      throw new Error("Cannot reconnect an edge to a missing node");
    }
    const validation = this.validateConnection(
      nextSource,
      nextTarget,
      nextSourceHandle,
      nextTargetHandle,
      this.edges.filter((edge) => edge.id !== edgeId),
    );
    if (!validation.valid) throw new Error(validation.reason);
    this._captureUndoState();
    this.edges = this.edges.map(e => {
      if (e.id === edgeId) {
        return {
          ...e,
          source: nextSource,
          target: nextTarget,
          sourceHandle: nextSourceHandle,
          targetHandle: nextTargetHandle,
        };
      }
      return e;
    });

    this.events.emit("edge_reconnected", {
      edgeId,
      source: newSource,
      target: newTarget,
      sourceHandle: newSourceHandle,
      targetHandle: newTargetHandle,
    });
    this.events.emit("graph_changed", {
      nodeCount: this.nodes.length,
      edgeCount: this.edges.length,
    });
  }

  // ── Position / Movement ──────────────────────────────────────

  public moveNode(id: string, x: number, y: number): void {
    this._captureUndoState();
    this.nodes = this.nodes.map(n =>
      n.id === id ? { ...n, position: { x, y } } : n
    );
    this.events.emit("node_moved", { nodeId: id, position: { x, y } });
    this.events.emit("graph_changed", {
      nodeCount: this.nodes.length,
      edgeCount: this.edges.length,
    });
  }

  public moveNodes(positions: Array<{ id: string; x: number; y: number }>): void {
    this._captureUndoState();
    const posMap = new Map(positions.map(p => [p.id, { x: p.x, y: p.y }]));
    this.nodes = this.nodes.map(n => {
      const pos = posMap.get(n.id);
      return pos ? { ...n, position: pos } : n;
    });
    for (const p of positions) {
      this.events.emit("node_moved", { nodeId: p.id, position: { x: p.x, y: p.y } });
    }
    this.events.emit("graph_changed", {
      nodeCount: this.nodes.length,
      edgeCount: this.edges.length,
    });
  }

  // ── Snapshots ─────────────────────────────────────────────────

  public getSnapshot(): DiagramCoreSnapshot {
    return { nodes: [...this.nodes], edges: [...this.edges] };
  }

  public restoreSnapshot(snapshot: DiagramCoreSnapshot): void {
    this.nodes = [...snapshot.nodes];
    this.edges = [...snapshot.edges];
    this.events.emit("diagram_reset", { nodes: this.nodes, edges: this.edges });
    this.events.emit("graph_changed", {
      nodeCount: this.nodes.length,
      edgeCount: this.edges.length,
    });
  }

  // ── Connection Validation ────────────────────────────────────

  public checkValidConnection(
    source: string,
    target: string,
    sourceHandle?: string,
    targetHandle?: string
  ): boolean {
    const result = this.validateConnection(source, target, sourceHandle, targetHandle);
    return result.valid;
  }

  /** Shared non-mutating connection validator used by UI, RPC, import, and reconnect. */
  public validateConnection(
    source: string,
    target: string,
    sourceHandle?: string,
    targetHandle?: string,
    edges: Edge[] = this.edges,
    includeOccupancy = true,
    nodes: Node[] = this.nodes,
  ): ReturnType<typeof coreCheckValidConnection> {
    const targetNode = nodes.find((node) => node.id === target);
    const observableTarget = this.isObservableNode(targetNode);
    const observationError = observableTarget
      ? this.getObservationConnectionError(source, target, sourceHandle ?? "out", targetHandle ?? "in", nodes)
      : undefined;
    if (observationError) return { valid: false, reason: observationError };
    return coreCheckValidConnection(
      includeOccupancy ? edges : [],
      source,
      target,
      sourceHandle,
      observableTarget ? targetHandle ?? "in" : targetHandle,
      nodes,
      (node) => this.isObservableNode(node),
    );
  }

  // ── Private Helpers ───────────────────────────────────────────

  private getObservationConnectionError(sourceId: string, targetId: string, sourceHandle: string, targetHandle: string, nodes: Node[]): string | undefined {
    const source = nodes.find((node) => node.id === sourceId);
    const target = nodes.find((node) => node.id === targetId);
    if (!this.isObservableNode(target)) return;
    const targetStereo = target ? this.getStereotype(String(target.data.stereotype ?? "")) : undefined;
    if (!targetStereo?.isObservable || !targetStereo.observable) return "Observable target is not compatible with its stereotype category";
    if (sourceHandle !== "out") {
      const sourceStereo = source ? this.getStereotype(String(source.data.stereotype ?? "")) : undefined;
      if (!sourceStereo?.observablePoints.some((point) => point.id === sourceHandle)) {
        return `Unknown Observable source point '${sourceHandle}'`;
      }
    }
    if (!targetStereo.observable.inputs.some((input) => input.id === targetHandle)) {
      return `Unknown Observable target handle '${targetHandle}'`;
    }
    return undefined;
  }

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
    userParams?: Record<string, unknown>
  ): Record<string, { value: string; position?: string }> {
    const merged = this.getDefaultParams(stereotype);
    if (userParams) {
      for (const [key, value] of Object.entries(userParams)) {
        const existing = merged[key];
        // Handle both formats: plain string (from create_node RPC) and
        // { value } wrapper (from duplicateNodes RPC)
        const innerValue =
          typeof value === 'object' && value !== null && 'value' in value
            ? String((value as { value: unknown }).value)
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
    };
    return JSON.stringify(exportData, null, 2);
  }

  public importFromJson(jsonString: string): boolean {
    try {
      const parsedData = JSON.parse(jsonString);

      if (Array.isArray(parsedData.nodes) && Array.isArray(parsedData.edges)) {
        const importedNodes = parsedData.nodes as Node[];
        const nodeIds = new Set(importedNodes.map((node) => node.id));
        const importedEdges = (parsedData.edges as Edge[]).map((edge) => ({
          ...edge,
          sourceHandle: edge.sourceHandle ?? "out",
          targetHandle: edge.targetHandle ?? "in",
        }));
        const categoryMismatch = importedNodes.find((node) => {
          const structuralObservable = node.type === "observable" || node.data?.isObservable === true;
          const categoryObservable = this.getStereotype(String(node.data?.stereotype ?? ""))?.isObservable === true;
          return structuralObservable !== categoryObservable;
        });
        if (categoryMismatch) {
          throw new Error(
            `Observable structure does not match stereotype category for node '${categoryMismatch.id}'`,
          );
        }
        const invalidEdge = importedEdges.find((edge) => {
          const source = importedNodes.find((node) => node.id === edge.source);
          const target = importedNodes.find((node) => node.id === edge.target);
          return !source || !target || this.isObservableNode(source);
        });
        if (invalidEdge) {
          throw new Error(`Invalid imported edge '${invalidEdge.id}'`);
        }
        // Validate completely before replacing the current diagram.
        if (importedNodes.some((node) => !node.id) || nodeIds.size !== importedNodes.length || importedEdges.some((edge) => !edge.id || !nodeIds.has(edge.source) || !nodeIds.has(edge.target))) {
          throw new Error("Imported diagram contains invalid node or edge references");
        }
        for (const edge of importedEdges) {
          const validation = this.validateConnection(
            edge.source,
            edge.target,
            edge.sourceHandle ?? "out",
            edge.targetHandle ?? "in",
            importedEdges,
            false,
            importedNodes,
          );
          if (!validation.valid && validation.reason !== undefined && !validation.reason.includes("already occupied")) {
            throw new Error(`Invalid imported edge '${edge.id}': ${validation.reason}`);
          }
        }
        this._captureUndoState();
        // No callbacks needed — SubflowNode uses getContext to access diagram.
        this.nodes = importedNodes;
        this.edges = importedEdges;
      } else {
        throw new Error("Il file JSON non contiene un formato valido (nodi o edges mancanti).");
      }
    } catch (error) {
      console.error("Errore durante l'importazione del modello:", error);
      return false;
    }

    this.events.emit("diagram_imported", { nodes: this.nodes, edges: this.edges });
    this.events.emit("graph_changed", {
      nodeCount: this.nodes.length,
      edgeCount: this.edges.length,
    });
    return true;
  }
}

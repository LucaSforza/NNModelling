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

// front-end/src/sync/BrowserRPCHandler.ts
// Browser-side RPC handler. Receives JSON-RPC requests from the MCP server
// via WebSocket, dispatches them to the browser's Diagram instance, and
// returns results. The browser is the single source of truth for diagram state.
//
// Protocol:
//   Server → Client: { id: string, method: string, params?: Record<string, unknown> }
//   Client → Server: { id: string, result?: unknown }
//                  | { id: string, error: { message: string } }

import type { Diagram } from "../Diagram.svelte";
import { NNTree } from "../conversion/nnTree";
import {
  getNodeTypeInfo,
  serializeTypeResult,
} from "../conversion/typeDiagnostics";
import type { Node, Edge } from "@xyflow/svelte";

// ── RPC Types ──────────────────────────────────────────────────────────

interface RPCRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

interface RPCResponse {
  id: string;
  result?: unknown;
  error?: { message: string };
}

// The WebSocket protocol defines OPEN as readyState 1. Keeping the value
// local makes response dispatch independent of a global WebSocket constructor,
// which is absent in Node 20 test environments.
const WEBSOCKET_OPEN = 1;

// ── Viewport Controller Interface ────────────────────────────────────────

/**
 * Minimal viewport controller interface.
 * Mirrors the subset of SvelteFlow's useSvelteFlow() API we need.
 *
 * fitView: SvelteFlow's FitViewOptions.nodes accepts (Node | { id: string })[]
 *   so we pass { id: nodeId } objects from string IDs.
 * setCenter: SvelteFlow's SetCenterOptions accepts zoom.
 */
export interface ViewportController {
  fitView: (options?: { nodes?: Array<{ id: string }> }) => void | Promise<boolean>;
  setCenter: (x: number, y: number, options?: { zoom?: number }) => void | Promise<boolean>;
}

// ── BrowserRPCHandler ─────────────────────────────────────────────────

export class BrowserRPCHandler {
  private ws: WebSocket | null = null;
  private diagram: Diagram;
  private url: string;
  private reconnectDelay: number = 1000;
  private intentionalClose: boolean = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private viewport?: ViewportController;

  /**
   * @param diagram  The Diagram instance to mutate (single source of truth).
   * @param url      WebSocket URL. Defaults to /ws in dev (proxied via Vite),
   *                 or ws://localhost:9339 in production.
   * @param viewport Optional viewport controller (fitView/setCenter).
   *                 Passed from FlowCanvas.svelte via useSvelteFlow().
   */
  constructor(diagram: Diagram, url?: string, viewport?: ViewportController) {
    this.diagram = diagram;
    this.url =
      url ??
      (import.meta.env.DEV
        ? `ws://${window.location.host}/ws`
        : `ws://localhost:9339`);
    this.viewport = viewport;
  }

  // ── Public API ───────────────────────────────────────────────────────

  /** Open the WebSocket connection and start listening for RPC requests. */
  connect(): void {
    this.intentionalClose = false;
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.debug(`[BrowserRPCHandler] Connected to ${this.url}`);
      this.reconnectDelay = 1000; // Reset exponential backoff
    };

    this.ws.onmessage = (event: MessageEvent) => {
      this.handleMessage(event);
    };

    this.ws.onclose = () => {
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (event: Event) => {
      console.error("[BrowserRPCHandler] WebSocket error:", event);
    };
  }

  /** Close the WebSocket connection and stop reconnecting. */
  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  // ── Message Handling ─────────────────────────────────────────────────

  private handleMessage(event: MessageEvent): void {
    let request: unknown;
    try {
      request = JSON.parse(event.data as string);
    } catch {
      console.error("[BrowserRPCHandler] Failed to parse message:", event.data);
      return;
    }

    const rpc = request as RPCRequest;
    if (typeof rpc.id !== "string" || typeof rpc.method !== "string") {
      console.warn("[BrowserRPCHandler] Invalid RPC request:", request);
      return;
    }

    this.dispatch(rpc);
  }

  /** Send a response back through the WebSocket. */
  private sendResponse(response: RPCResponse): void {
    if (this.ws && this.ws.readyState === WEBSOCKET_OPEN) {
      this.ws.send(JSON.stringify(response));
    }
  }

  /** Route an incoming RPC request to the appropriate handler. */
  private dispatch(request: RPCRequest): void {
    const { id, method, params = {} } = request;

    try {
      let result: unknown;

      switch (method) {
        // ── Inspection ────────────────────────────────────────────
        case "get_graph":
          result = this.handleGetGraph();
          break;
        case "get_node":
          result = this.handleGetNode(params);
          break;
        case "get_type_info":
          result = this.handleGetTypeInfo(params);
          break;
        case "get_edges":
          result = this.handleGetEdges(params);
          break;
        case "get_subflow":
          result = this.handleGetSubflow(params);
          break;
        case "graph_statistics":
          result = this.handleGraphStatistics();
          break;
        case "list_stereotypes":
          result = this.handleListStereotypes(params);
          break;

        // ── Mutations ─────────────────────────────────────────────
        case "create_node":
          result = this.handleCreateNode(params);
          break;
        case "delete_nodes":
          result = this.handleDeleteNodes(params);
          break;
        case "connect_nodes":
          result = this.handleConnectNodes(params);
          break;
        case "disconnect_nodes":
          result = this.handleDisconnectNodes(params);
          break;
        case "move_nodes":
          result = this.handleMoveNodes(params);
          break;
        case "duplicate_nodes":
          result = this.handleDuplicateNodes(params);
          break;
        case "create_subflow":
          result = this.handleCreateSubflow(params);
          break;

        // ── Parameters ───────────────────────────────────────────
        case "set_parameter":
          result = this.handleSetParameter(params);
          break;
        case "update_parameters":
          result = this.handleUpdateParameters(params);
          break;
        case "reset_parameters":
          result = this.handleResetParameters(params);
          break;
        case "query_parameters":
          result = this.handleQueryParameters(params);
          break;

        // ── Selection ─────────────────────────────────────────────
        case "select_nodes":
          result = this.handleSelectNodes(params);
          break;
        case "clear_selection":
          result = this.handleClearSelection();
          break;
        case "get_selection":
          result = this.handleGetSelection();
          break;
        case "select_all":
          result = this.handleSelectAll();
          break;

        // ── Compilation / Serialization ───────────────────────────
        case "compile_nntree":
          result = this.handleCompileNntree();
          break;
        case "export_diagram":
          result = this.handleExportDiagram();
          break;
        case "import_diagram":
          result = this.handleImportDiagram(params);
          break;

        // ── Canvas / Viewport ─────────────────────────────────────
        case "get_canvas_state":
          result = this.handleGetCanvasState();
          break;
        case "fit_view":
          result = this.handleFitView(params);
          break;
        case "center_view":
          result = this.handleCenterView(params);
          break;

        // ── Validation ────────────────────────────────────────────
        case "validate_graph":
          result = this.handleValidateGraph();
          break;
        case "validate_connections":
          result = this.handleValidateConnections();
          break;
        case "validate_parameters":
          result = { valid: true, errors: [], warnings: [] };
          break;
        case "validate_subflows":
          result = { valid: true, errors: [], warnings: [] };
          break;

        // ── Lifecycle ─────────────────────────────────────────────
        case "reset_diagram":
          result = this.handleResetDiagram();
          break;
        case "ping":
          result = this.handlePing();
          break;

        default:
          throw new Error(`Unknown method: ${method}`);
      }

      this.sendResponse({ id, result });
    } catch (error) {
      this.sendResponse({
        id,
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  // ── Reconnection (exponential backoff) ───────────────────────────────

  private scheduleReconnect(): void {
    const delay = this.reconnectDelay;
    console.debug(`[BrowserRPCHandler] Reconnecting in ${delay}ms...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30000);
      this.connect();
    }, delay);
  }

  // ══════════════════════════════════════════════════════════════════════
  //  HANDLER IMPLEMENTATIONS
  // ══════════════════════════════════════════════════════════════════════

  // ── Inspection Handlers ─────────────────────────────────────────────

  private handleGetGraph(): Record<string, unknown> {
    const typeResult = this.diagram.refreshTypes();
    return {
      nodes: this.diagram.nodes,
      edges: this.diagram.edges,
      typeInfo: serializeTypeResult(typeResult),
    };
  }

  private handleGetNode(params: Record<string, unknown>): Record<string, unknown> {
    const nodeId = params.nodeId as string;
    if (!nodeId) throw new Error("Missing required parameter: nodeId");
    const node = this.diagram.getNodeById(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    const typeResult = this.diagram.refreshTypes();
    return { ...node, typeInfo: getNodeTypeInfo(typeResult, nodeId) };
  }

  private handleGetTypeInfo(params: Record<string, unknown>): unknown {
    const nodeId = params.nodeId as string | undefined;
    if (nodeId && !this.diagram.getNodeById(nodeId)) {
      throw new Error(`Node not found: ${nodeId}`);
    }

    const refresh = params.refresh !== false;
    const typeResult = refresh || !this.diagram.typeResult
      ? this.diagram.refreshTypes()
      : this.diagram.typeResult;

    return nodeId
      ? getNodeTypeInfo(typeResult, nodeId)
      : serializeTypeResult(typeResult);
  }

  private handleGetEdges(params: Record<string, unknown>): { edges: Edge[] } {
    const nodeId = params.nodeId as string | undefined;
    if (nodeId) {
      if (!this.diagram.getNodeById(nodeId)) throw new Error(`Node '${nodeId}' not found`);
      return { edges: this.diagram.edges.filter(
        (e) => e.source === nodeId || e.target === nodeId,
      ) };
    }
    return { edges: [...this.diagram.edges] };
  }

  private handleGetSubflow(params: Record<string, unknown>): { nodes: Node[]; edges: Edge[] } {
    const parentId = params.parentId as string;
    if (!parentId) throw new Error("Missing required parameter: parentId");
    if (!this.diagram.getNodeById(parentId)) throw new Error(`Node '${parentId}' not found`);
    const nodes = this.diagram.nodes.filter((n) => n.parentId === parentId);
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges = this.diagram.edges.filter(
      (e) => nodeIds.has(e.source) && nodeIds.has(e.target),
    );
    return { nodes, edges };
  }

  private handleGraphStatistics(): Record<string, unknown> {
    const nodes = this.diagram.nodes;
    const edges = this.diagram.edges;

    let moduleCount = 0;
    let joinCount = 0;
    let subflowCount = 0;
    let inputCount = 0;
    let lossCount = 0;

    for (const node of nodes) {
      if (node.type === "join") {
        joinCount++;
      } else if (node.type === "subflow") {
        subflowCount++;
      } else {
        moduleCount++;
      }
      // Additive counting: Input/Loss are counted in addition to type counts
      const stereo = this.diagram.getStereotype((node.data as Record<string, unknown>).stereotype as string);
      if (stereo?.isInput) inputCount++;
      if (stereo?.isLoss) lossCount++;
    }

    return {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      moduleCount,
      joinCount,
      subflowCount,
      inputCount,
      lossCount,
    };
  }

  private handleListStereotypes(params: Record<string, unknown>): Record<string, unknown> {
    const category = params.category as string | undefined;
    let list = this.diagram.stereotypes;
    if (category) {
      list = list.filter((s) => s.category === category);
    }
    return {
      stereotypes: list.map((s) => ({
        name: s.name,
        category: s.category,
        pythonClassName: s.pythonClassName,
        isJoin: s.isJoin,
        isInput: s.isInput,
        isLoss: s.isLoss,
        isSubFlow: s.isSubFlow,
        isObservable: s.isObservable,
        observable: s.observable,
        parameters: s.parameters,
        view: s.view,
      })),
    };
  }

  // ── Mutation Handlers ───────────────────────────────────────────────

  private handleCreateNode(params: Record<string, unknown>): Record<string, unknown> {
    const stereotypeName = params.stereotype as string;
    if (!stereotypeName) throw new Error("Missing required parameter: stereotype");
    const stereo = this.diagram.getStereotype(stereotypeName);
    if (!stereo) throw new Error(`Stereotype not found: ${stereotypeName}`);

    const position = params.position as { x: number; y: number } | undefined;
    const x = position?.x ?? 0;
    const y = position?.y ?? 0;
    const config = (params.config || {}) as Record<string, unknown>;

    const beforeCount = this.diagram.nodes.length;

    if (stereo.isJoin) {
      this.diagram.addJoinNode(stereo, x, y, {
        name: config.name as string | undefined,
        inputsCount: (config.inputsCount as number) ?? 2,
        color: config.color as string | undefined,
        params: (config.params as Record<string, string>) ?? {},
      });
    } else {
      this.diagram.addModule(stereo, x, y, {
        name: config.name as string | undefined,
        color: config.color as string | undefined,
        width: config.width as number | undefined,
        height: config.height as number | undefined,
        params: (config.params as Record<string, string>) ?? {},
        enabled: config.enabled as boolean | undefined,
      });
    }

    // Capture the newly added node (last in the array)
    const added = this.diagram.nodes[beforeCount];
    if (!added) throw new Error("Failed to create node");

    return {
      nodeId: added.id,
      name: (added.data as Record<string, unknown>).name ?? stereotypeName,
      type: added.type ?? "custom",
      stereotype: stereotypeName,
    };
  }

  private handleDeleteNodes(params: Record<string, unknown>): Record<string, unknown> {
    const nodeIds = params.nodeIds as string[];
    if (!Array.isArray(nodeIds)) throw new Error("nodeIds must be an array");

    // Validate all IDs exist
    for (const id of nodeIds) {
      if (!this.diagram.getNodeById(id)) throw new Error(`Node not found: ${id}`);
    }

    // Capture edge IDs that will be removed
    const deletedEdgeIds = this.diagram.edges
      .filter((e) => nodeIds.includes(e.source) || nodeIds.includes(e.target))
      .map((e) => e.id);

    this.diagram.deleteNodes(nodeIds);

    return {
      deletedNodeIds: nodeIds,
      deletedEdgeIds,
      reparentedNodes: [],
    };
  }

  private handleConnectNodes(params: Record<string, unknown>): Record<string, unknown> {
    const source = params.source as string;
    const target = params.target as string;
    if (!source || !target) throw new Error("Missing required parameters: source, target");

    // Validate source and target exist
    if (!this.diagram.getNodeById(source)) throw new Error(`Source node not found: ${source}`);
    if (!this.diagram.getNodeById(target)) throw new Error(`Target node not found: ${target}`);

    const sourceHandle = params.sourceHandle as string | undefined;
    const targetHandle = params.targetHandle as string | undefined;

    const edge = this.diagram.addEdge(source, target, sourceHandle, targetHandle);

    return { edgeId: edge.id, source, target };
  }

  private handleDisconnectNodes(params: Record<string, unknown>): Record<string, unknown> {
    const source = params.source as string;
    const target = params.target as string;
    if (!source || !target) throw new Error("Missing required parameters: source, target");

    const targetHandle = params.targetHandle as string | undefined;

    // Find matching edges before removal
    const removedEdges = this.diagram.edges.filter(
      (e) =>
        e.source === source &&
        e.target === target &&
        (targetHandle === undefined || e.targetHandle === targetHandle),
    );
    const removedEdgeIds = removedEdges.map((e) => e.id);

    this.diagram.removeEdge(source, target, targetHandle);

    return { removedEdgeIds };
  }

  private handleMoveNodes(params: Record<string, unknown>): Record<string, unknown> {
    const positions = params.positions as Array<{ id: string; x: number; y: number }>;
    if (!Array.isArray(positions)) throw new Error("positions must be an array");

    // Validate all nodes exist
    for (const p of positions) {
      if (!this.diagram.getNodeById(p.id)) throw new Error(`Node not found: ${p.id}`);
    }

    this.diagram.moveNodes(positions);

    return { movedCount: positions.length };
  }

  private handleDuplicateNodes(params: Record<string, unknown>): Record<string, unknown> {
    const nodeIds = params.nodeIds as string[];
    if (!Array.isArray(nodeIds)) throw new Error("nodeIds must be an array");

    const offset = (params.offset as { x: number; y: number }) ?? { x: 50, y: 50 };
    const offsetX = offset.x;
    const offsetY = offset.y;

    // Capture edges between the selected nodes BEFORE any mutations
    const edgesBetweenSelected = this.diagram.edges.filter(
      (e) => nodeIds.includes(e.source) && nodeIds.includes(e.target),
    );

    const oldToNew = new Map<string, string>();
    const duplicated: Array<{ originalId: string; newId: string }> = [];

    for (const id of nodeIds) {
      const node = this.diagram.getNodeById(id);
      if (!node) throw new Error(`Node not found: ${id}`);
      // Skip subflow nodes
      if (node.type === "subflow") continue;

      const nd = node.data as Record<string, unknown>;
      const stereo = this.diagram.getStereotype(nd.stereotype as string);
      if (!stereo) throw new Error(`Stereotype not found for node ${id}`);

      const beforeCount = this.diagram.nodes.length;
      const newPos = {
        x: node.position.x + offsetX,
        y: node.position.y + offsetY,
      };

      if (node.type === "join" || stereo.isJoin) {
        this.diagram.addJoinNode(stereo, newPos.x, newPos.y, {
          name: nd.name as string | undefined,
          inputsCount: nd.inputsCount as number | undefined,
          color: nd.color as string | undefined,
          params: nd.params as Record<string, unknown> | undefined,
        });
      } else {
        this.diagram.addModule(stereo, newPos.x, newPos.y, {
          name: nd.name as string | undefined,
          color: nd.color as string | undefined,
          params: nd.params as Record<string, unknown> | undefined,
        });
      }

      const newNode = this.diagram.nodes[beforeCount];
      if (newNode) {
        oldToNew.set(id, newNode.id);
        duplicated.push({ originalId: id, newId: newNode.id });
      }
    }

    // Re-create edges between duplicated nodes
    for (const edge of edgesBetweenSelected) {
      const newSource = oldToNew.get(edge.source);
      const newTarget = oldToNew.get(edge.target);
      if (newSource && newTarget) {
        try {
          this.diagram.addEdge(newSource, newTarget, edge.sourceHandle ?? undefined, edge.targetHandle ?? undefined);
        } catch {
          // Edge may already exist or be invalid — skip silently
        }
      }
    }

    return { duplicated };
  }

  private handleCreateSubflow(params: Record<string, unknown>): Record<string, unknown> {
    const position = params.position as { x: number; y: number } | undefined;
    const x = position?.x ?? 0;
    const y = position?.y ?? 0;

    const beforeCount = this.diagram.nodes.length;
    this.diagram.addSubGraph(x, y);

    const newSubflow = this.diagram.nodes[beforeCount];
    if (!newSubflow) throw new Error("Failed to create subflow");

    // If label is provided, update both name and label
    if (params.label) {
      this.diagram.updateModule(newSubflow.id, {
        name: params.label as string,
        label: params.label as string,
      });
    }

    return {
      nodeId: newSubflow.id,
      name: (params.label as string) ?? ((newSubflow.data as Record<string, unknown>).name as string) ?? newSubflow.id,
    };
  }

  // ── Parameter Handlers ──────────────────────────────────────────────

  // NOTE: Param values use { value: string } wrapper (canonical frontend format),
  // not plain strings as described in the design doc protocol spec.
  private handleSetParameter(params: Record<string, unknown>): Record<string, unknown> {
    const nodeId = params.nodeId as string;
    const key = params.key as string;
    const value = params.value as string;
    if (!nodeId || !key) throw new Error("Missing required parameters: nodeId, key");

    const node = this.diagram.getNodeById(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);

    const currentParams = node.data.params as Record<string, { value: string }> | undefined;
    const previousValue = currentParams?.[key]?.value;
    const stereotypeName = node.data.stereotype as string | undefined;
    const parameterDefinition = stereotypeName
      ? this.diagram.getStereotype(stereotypeName)?.parameters[key]
      : undefined;

    this.diagram.updateModule(nodeId, {
      params: {
        ...(currentParams || {}),
        [key]: {
          ...(parameterDefinition?.position ? { position: parameterDefinition.position } : {}),
          ...(currentParams?.[key] || {}),
          value,
        },
      },
    });

    return { nodeId, key, previousValue: previousValue ?? "", currentValue: value };
  }

  // NOTE: Param values use { value: string } wrapper (canonical frontend format),
  // not plain strings as described in the design doc protocol spec.
  private handleUpdateParameters(params: Record<string, unknown>): Record<string, unknown> {
    const nodeId = params.nodeId as string;
    const newParamValues = params.params as Record<string, string> | undefined;
    if (!nodeId) throw new Error("Missing required parameter: nodeId");
    if (!newParamValues || typeof newParamValues !== "object") throw new Error("params must be an object");

    const node = this.diagram.getNodeById(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);

    const currentParams = (node.data.params as Record<string, { value: string }>) || {};
    const stereotypeName = node.data.stereotype as string | undefined;
    const stereotype = stereotypeName
      ? this.diagram.getStereotype(stereotypeName)
      : undefined;
    const updated: Array<{ key: string; previousValue: string; currentValue: string }> = [];
    const unchanged: string[] = [];

    const newParams = { ...currentParams };
    for (const [key, value] of Object.entries(newParamValues)) {
      const prev = newParams[key]?.value;
      if (prev !== value) {
        updated.push({ key, previousValue: prev ?? "", currentValue: value });
      } else {
        unchanged.push(key);
      }
      // Parameter objects also carry presentation metadata such as
      // `position: "top" | "bottom"`. Recover it from the stereotype when an
      // older RPC update has already stripped it from the live node.
      const parameterDefinition = stereotype?.parameters[key];
      newParams[key] = {
        ...(parameterDefinition?.position ? { position: parameterDefinition.position } : {}),
        ...(newParams[key] || {}),
        value,
      };
    }

    this.diagram.updateModule(nodeId, { params: newParams });

    return { nodeId, updated, unchanged };
  }

  // NOTE: Param values use { value: string } wrapper (canonical frontend format),
  // not plain strings as described in the design doc protocol spec.
  private handleResetParameters(params: Record<string, unknown>): Record<string, unknown> {
    const nodeId = params.nodeId as string;
    if (!nodeId) throw new Error("Missing required parameter: nodeId");

    const node = this.diagram.getNodeById(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);

    const nd = node.data as Record<string, unknown>;
    const stereo = this.diagram.getStereotype(nd.stereotype as string);
    const currentParams = (nd.params as Record<string, { value: string }>) || {};
    const reset: Array<{ key: string; previousValue: string; defaultValue: string }> = [];

    if (!stereo) {
      // No stereotype: clear all current params
      for (const key of Object.keys(currentParams)) {
        const prev = currentParams[key]?.value ?? "";
        reset.push({ key, previousValue: prev, defaultValue: "" });
      }
      this.diagram.updateModule(nodeId, { params: {} });
    } else {
      const newParams = { ...currentParams };
      const keysToReset = (params.keys as string[]) ?? Object.keys(stereo.parameters);
      for (const key of keysToReset) {
        const defaultDef = stereo.parameters[key];
        if (!defaultDef) continue;

        const prev = newParams[key]?.value ?? "";
        if (prev !== defaultDef.default) {
          reset.push({ key, previousValue: prev, defaultValue: defaultDef.default });
        }
        newParams[key] = { value: defaultDef.default };
      }
      this.diagram.updateModule(nodeId, { params: newParams });
    }

    return { nodeId, reset };
  }

  // NOTE: Param values use { value: string } wrapper (canonical frontend format),
  // not plain strings as described in the design doc protocol spec.
  private handleQueryParameters(params: Record<string, unknown>): Record<string, unknown> {
    const rawIds = params.nodeId as string | string[] | undefined;
    if (!rawIds) throw new Error("Missing required parameter: nodeId");

    const ids = Array.isArray(rawIds) ? rawIds : [rawIds];
    const nodes: Array<Record<string, unknown>> = [];

    for (const id of ids) {
      const node = this.diagram.getNodeById(id);
      if (!node) throw new Error(`Node not found: ${id}`);

      const nd = node.data as Record<string, unknown>;
      const stereo = this.diagram.getStereotype(nd.stereotype as string);
      if (!stereo) throw new Error(`Stereotype not found for node ${id}`);

      // NOTE: currentParams uses { value: string } wrapper (canonical frontend format)
      const currentParams = (nd.params as Record<string, { value: string }>) || {};
      const definitions = stereo.parameters;

      const paramList: Array<{
        key: string;
        type: string;
        defaultValue: string;
        currentValue: string;
        isModified: boolean;
        position?: string;
      }> = [];

      for (const [key, def] of Object.entries(definitions)) {
        const currentVal = currentParams[key]?.value ?? def.default;
        paramList.push({
          key,
          type: def.type,
          defaultValue: def.default,
          currentValue: currentVal,
          isModified: currentVal !== def.default,
          position: def.position,
        });
      }

      // Add custom params present in currentParams but not in stereotype definition
      for (const [key, val] of Object.entries(currentParams)) {
        if (!definitions[key]) {
          paramList.push({
            key,
            type: "string",
            defaultValue: "",
            currentValue: val?.value ?? "",
            isModified: true,
            position: undefined,
          });
        }
      }

      nodes.push({
        nodeId: id,
        name: (nd.name as string) ?? id,
        stereotype: (nd.stereotype as string) ?? "unknown",
        params: paramList,
      });
    }

    return { nodes };
  }

  // ── Selection Handlers ──────────────────────────────────────────────

  private handleSelectNodes(params: Record<string, unknown>): Record<string, unknown> {
    const nodeIds = params.nodeIds as string[];
    if (!Array.isArray(nodeIds)) throw new Error("nodeIds must be an array");

    const mode = (params.mode as string) ?? "replace";

    // Validate all IDs exist
    for (const id of nodeIds) {
      if (!this.diagram.getNodeById(id)) throw new Error(`Node not found: ${id}`);
    }

    let finalIds: string[];
    switch (mode) {
      case "replace":
        finalIds = nodeIds;
        break;
      case "add": {
        const current = new Set(this.diagram.getSelectedNodes().map((n) => n.id));
        for (const id of nodeIds) current.add(id);
        finalIds = [...current];
        break;
      }
      case "remove": {
        const removeSet = new Set(nodeIds);
        finalIds = this.diagram
          .getSelectedNodes()
          .map((n) => n.id)
          .filter((id) => !removeSet.has(id));
        break;
      }
      default:
        throw new Error(`Unknown selection mode: ${mode}. Use "replace", "add", or "remove".`);
    }

    this.diagram.selectNodes(finalIds);

    return { selectedNodeIds: finalIds, selectedEdgeIds: this.diagram.getSelectedEdges().map(e => e.id) };
  }

  private handleClearSelection(): Record<string, unknown> {
    this.diagram.clearSelection();
    return { cleared: true };
  }

  private handleGetSelection(): Record<string, unknown> {
    const selNodes = this.diagram.getSelectedNodes();
    const selEdges = this.diagram.getSelectedEdges();
    return {
      nodeIds: selNodes.map(n => n.id),
      edgeIds: selEdges.map(e => e.id),
      nodes: selNodes,
      edges: selEdges,
    };
  }

  private handleSelectAll(): Record<string, unknown> {
    const allIds = this.diagram.nodes.map((n) => n.id);
    this.diagram.selectNodes(allIds);
    return { nodeCount: allIds.length };
  }

  // ── Compilation / Serialization Handlers ────────────────────────────

  private handleCompileNntree(): Record<string, unknown> {
    const typeResult = this.diagram.refreshTypes();
    const blockingErrors = typeResult.errors.filter(
      (error) => error.severity === "error",
    );
    if (blockingErrors.length > 0) {
      const summary = blockingErrors
        .slice(0, 5)
        .map((error) => `${error.nodeId || "graph"}: ${error.message}`)
        .join("; ");
      throw new Error(
        `NNTree compilation blocked by ${blockingErrors.length} type error(s): ${summary}`,
      );
    }

    const nnTree = new NNTree(this.diagram as any);
    const json = nnTree.toJson();

    let subflowCount = 0;
    for (const [, node] of nnTree.nodes) {
      if (node.isSubflow()) subflowCount++;
    }

    return {
      json,
      root: nnTree.root,
      nodeCount: nnTree.nodes.size,
      subflowCount,
      lossNodeType: nnTree.lossNode?.stereotype ?? null,
    };
  }

  private handleExportDiagram(): Record<string, unknown> {
    return { json: this.diagram.exportToJson(), nodeCount: this.diagram.nodes.length, edgeCount: this.diagram.edges.length };
  }

  private handleImportDiagram(params: Record<string, unknown>): Record<string, unknown> {
    const jsonString = params.json as string;
    if (!jsonString) throw new Error("Missing required parameter: json");

    // Validate JSON structure
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonString);
    } catch {
      throw new Error("Invalid JSON string");
    }

    const data = parsed as Record<string, unknown>;
    if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
      throw new Error("JSON must have 'nodes' and 'edges' arrays");
    }

    this.diagram.importFromJson(jsonString);

    return {
      success: true,
      nodeCount: this.diagram.nodes.length,
      edgeCount: this.diagram.edges.length,
    };
  }

  // ── Validation Handler ──────────────────────────────────────────────

  private handleValidateGraph(): Record<string, unknown> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check for exactly 1 Input node
    const inputNodes = this.diagram.nodes.filter((n) => {
      const stereo = this.diagram.getStereotype((n.data as Record<string, unknown>).stereotype as string);
      return stereo?.isInput;
    });

    if (inputNodes.length === 0) {
      errors.push("No Input node found. Exactly 1 Input node is required.");
    } else if (inputNodes.length > 1) {
      errors.push(`Found ${inputNodes.length} Input nodes. Exactly 1 Input node is required.`);
    }

    // Check for at least 1 loss node
    const lossNodes = this.diagram.nodes.filter((n) => {
      const stereo = this.diagram.getStereotype((n.data as Record<string, unknown>).stereotype as string);
      return stereo?.isLoss;
    });

    if (lossNodes.length === 0) {
      errors.push(
        "No loss/output node found. Add a loss function (e.g. CrossEntropyLoss) to define the model output.",
      );
    }

    // Detect orphan nodes (no incoming or outgoing connections, except Input/Loss)
    for (const node of this.diagram.nodes) {
      const stereo = this.diagram.getStereotype((node.data as Record<string, unknown>).stereotype as string);
      if (stereo?.isObservable) continue;
      if (stereo?.isInput || stereo?.isLoss) continue;

      const hasIncoming = this.diagram.edges.some((e) => e.target === node.id);
      const hasOutgoing = this.diagram.edges.some((e) => e.source === node.id && !this.diagram.isObservableNode(this.diagram.getNodeById(e.target)));

      if (!hasIncoming && !hasOutgoing) {
        warnings.push(
          `Orphan node: "${node.data.name}" (${node.id}) has no connections.`,
        );
      } else if (!hasIncoming) {
        warnings.push(
          `Node "${node.data.name}" (${node.id}) has no incoming connections.`,
        );
      } else if (!hasOutgoing && node.type !== "join") {
        // Join nodes may not have outgoing edges if they are the last (output) node
        warnings.push(
          `Node "${node.data.name}" (${node.id}) has no outgoing connections.`,
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  private handleValidateConnections(): Record<string, unknown> {
    const errors: Array<{ edgeId: string; message: string }> = [];
    for (const edge of this.diagram.edges) {
      const result = this.diagram.validateConnection(
        edge.source,
        edge.target,
        edge.sourceHandle ?? undefined,
        edge.targetHandle ?? undefined,
        this.diagram.edges.filter((candidate) => candidate.id !== edge.id),
      );
      if (!result.valid) errors.push({ edgeId: edge.id, message: result.reason ?? "Invalid connection" });
    }
    return { valid: errors.length === 0, errors, warnings: [] };
  }

  // ── Canvas / Viewport Handlers ─────────────────────────────────────

  private handleGetCanvasState(): Record<string, unknown> {
    // Viewport state is managed by SvelteFlow on the browser side.
    // Return a basic state; full viewport access requires SvelteFlow API integration.
    return { zoom: 1, x: 0, y: 0 };
  }

  private handleFitView(params: Record<string, unknown>): Record<string, unknown> {
    if (this.viewport) {
      const nodeIds = params.nodeIds as string[] | undefined;
      if (Array.isArray(nodeIds) && nodeIds.length > 0) {
        this.viewport.fitView({ nodes: nodeIds.map((id) => ({ id })) });
      } else {
        this.viewport.fitView();
      }
      return { success: true };
    }
    // Graceful degradation when viewport controller is not available
    return { success: true, note: "fit_view executed" };
  }

  private handleCenterView(params: Record<string, unknown>): Record<string, unknown> {
    if (this.viewport) {
      const x = (params.x as number) ?? 0;
      const y = (params.y as number) ?? 0;
      const zoom = params.zoom as number | undefined;
      this.viewport.setCenter(x, y, { zoom });
      return { success: true };
    }
    // Graceful degradation when viewport controller is not available
    return { success: true, note: "center_view executed" };
  }

  // ── Lifecycle Handlers ──────────────────────────────────────────────

  private handleResetDiagram(): Record<string, unknown> {
    this.diagram.nodes.length = 0;
    this.diagram.edges.length = 0;
    return { success: true, message: "Diagram has been reset" };
  }

  private handlePing(): Record<string, unknown> {
    return {
      status: "ok",
      uptime: performance.now() / 1000,
      nodeCount: this.diagram.nodes.length,
      edgeCount: this.diagram.edges.length,
      activeTransaction: null,
    };
  }
}

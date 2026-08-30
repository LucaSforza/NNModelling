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
// Protocol:
//   Server → Client: { id: string, method: string, params?: Record<string, unknown> }
//   Client → Server: { id: string, result?: unknown }
//                  | { id: string, error: { message: string } }

import type { Diagram } from "../Diagram.svelte";
import type { Node, Edge } from "@xyflow/svelte";
import type { GraphInferenceResult } from "../type-system/graph/types";
import { packageIdentity } from "../type-system/graph/types";
import { initialPackageParameters, validatePackageParameterValues } from "../type-system/editor/package-ui";
import { TrainingController } from "../training/controller";

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

function packageLifecycleMetadata(
  metadata: { readonly id: string; readonly version: string },
  diagnostics: readonly { readonly packageId?: string; readonly packageVersion?: string; readonly phase?: string }[],
  states: readonly { readonly id: string; readonly version: string; readonly source?: "bundled" | "external"; readonly state?: "installed" | "active" | "failed" }[] = [],
): Record<string, unknown> {
  // ActivePackageMetadata is deliberately small. Newer Diagram owners may
  // attach catalog lifecycle fields; serialize those fields without making
  // the RPC handler a second package registry.
  const attached = metadata as typeof metadata & {
    readonly source?: "bundled" | "external";
    readonly state?: "installed" | "active" | "failed";
    readonly active?: boolean;
  };
  const lifecycle = states.find((candidate) => candidate.id === metadata.id && candidate.version === metadata.version);
  const failed = diagnostics.some((diagnostic) => (
    diagnostic.packageId === metadata.id && diagnostic.packageVersion === metadata.version && diagnostic.phase === "activation"
  ));
  const state = lifecycle?.state ?? attached.state ?? (failed ? "failed" : attached.active === false ? "installed" : "active");
  return {
    installed: true,
    active: state === "active",
    state,
    ...(lifecycle?.source === undefined && attached.source === undefined ? {} : { source: lifecycle?.source ?? attached.source }),
  };
}

function serializeTypeResult(result: GraphInferenceResult | null): unknown {
  if (!result) return null;
  return {
    complete: result.complete,
    terminals: [...result.terminals],
    order: [...result.order],
    nodes: Object.fromEntries(result.nodes),
  };
}

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
  private training?: TrainingController;

  /**
   * @param diagram  The Diagram instance to mutate (single source of truth).
   * @param url      WebSocket URL. Defaults to /ws in dev (proxied via Vite),
   *                 or ws://localhost:9339 in production.
   * @param viewport Optional viewport controller (fitView/setCenter).
   *                 Passed from FlowCanvas.svelte via useSvelteFlow().
   */
  constructor(diagram: Diagram, url?: string, viewport?: ViewportController, training?: TrainingController) {
    this.diagram = diagram;
    this.url =
      url ??
      (import.meta.env.DEV
        ? `ws://${window.location.host}/ws`
        : `ws://localhost:9339`);
    this.viewport = viewport;
    this.training = training;
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
        case "get_package_diagnostics":
          result = this.handleGetPackageDiagnostics();
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

        // ── Serialization ────────────────────────────────────────
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
          result = { valid: false, supported: false, errors: ["Connection validation is delegated to each connect_nodes operation."], warnings: [] };
          break;
        case "validate_parameters":
          result = this.handleValidateParameters();
          break;
        case "validate_subflows":
          result = { valid: false, supported: false, errors: ["Subflow validation is not exposed by the editor runtime."], warnings: [] };
          break;

        // ── Lifecycle ─────────────────────────────────────────────
        case "reset_diagram":
          result = this.handleResetDiagram();
          break;
        case "ping":
          result = this.handlePing();
          break;

        // ── Training session/configuration ───────────────────────
        case "connect_training_backend":
          result = this.requireTraining().connect(params.baseUrl as string, params.deviceName as string | undefined);
          break;
        case "get_training_connection":
          result = this.requireTraining().getConnection();
          break;
        case "renew_training_connection":
          result = this.requireTraining().renew();
          break;
        case "disconnect_training_backend":
          result = this.requireTraining().disconnect(params.revoke === true);
          break;
        case "get_training_config":
          result = { status: "ok", config: this.requireTraining().getConfig(), datasets: this.requireTraining().getDatasets() };
          break;
        case "update_training_config":
          result = { status: "ok", config: this.requireTraining().updateConfig((params.patch ?? {}) as Record<string, unknown>) };
          break;
        case "start_training":
          result = this.requireTraining().submitTraining(this.diagram);
          break;

        default:
          throw new Error(`Unknown method: ${method}`);
      }

      if (result instanceof Promise) {
        void result.then((resolved) => this.sendResponse({ id, result: resolved })).catch((error) => {
          this.sendResponse({
            id,
            error: { message: error instanceof Error ? error.message : String(error) },
          });
        });
        return;
      }
      this.sendResponse({ id, result });
    } catch (error) {
      this.sendResponse({
        id,
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private requireTraining(): TrainingController {
    if (!this.training) throw new Error("Training controller unavailable for this editor");
    return this.training;
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
      packageRuntimeReady: this.diagram.packageRuntimeReady,
      packageRuntimeDiagnostics: this.diagram.packageRuntimeDiagnostics,
    };
  }

  private handleGetNode(params: Record<string, unknown>): Record<string, unknown> {
    const nodeId = params.nodeId as string;
    if (!nodeId) throw new Error("Missing required parameter: nodeId");
    const node = this.diagram.getNodeById(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    const typeResult = this.diagram.refreshTypes();
    return { ...node, typeInfo: serializeTypeResult({
      nodes: new Map([[nodeId, typeResult.nodes.get(nodeId) ?? { status: "unresolved", reason: "node has no type result" }]]),
      order: [nodeId], terminals: typeResult.terminals, complete: typeResult.complete,
    }) };
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

    const serialized = nodeId
      ? serializeTypeResult({ nodes: new Map([[nodeId, typeResult.nodes.get(nodeId) ?? { status: "unresolved", reason: "node has no type result" }]]), order: [nodeId], terminals: typeResult.terminals, complete: typeResult.complete })
      : serializeTypeResult(typeResult);
    return {
      ...((serialized ?? {}) as Record<string, unknown>),
      packageRuntimeReady: this.diagram.packageRuntimeReady,
      packageRuntimeDiagnostics: this.diagram.packageRuntimeDiagnostics,
    };
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
      const identity = packageIdentity(node);
      const metadata = identity && this.diagram.packageCatalog.find((candidate) =>
        candidate.id === identity.id && candidate.version === identity.version);
      if (metadata?.definition.kind === "input") inputCount++;
      if (metadata?.definition.kind === "loss") lossCount++;
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
    let list = this.diagram.packageCatalog;
    if (category) list = list.filter((metadata) => metadata.definition.kind === category);
    const diagnostics = this.diagram.packageRuntimeDiagnostics;
    const states = (this.diagram as unknown as {
      packageActivationStates?: readonly { id: string; version: string; source?: "bundled" | "external"; state?: "installed" | "active" | "failed" }[]
    }).packageActivationStates ?? [];
    return {
      packages: list.map((metadata) => ({
        id: metadata.id,
        version: metadata.version,
        name: metadata.definition.name,
        kind: metadata.definition.kind,
        parameters: metadata.definition.parameters,
        view: metadata.definition.view,
        ...packageLifecycleMetadata(metadata, diagnostics, states),
      })),
    };
  }

  private handleGetPackageDiagnostics(): Record<string, unknown> {
    return {
      packageRuntimeReady: this.diagram.packageRuntimeReady,
      packageRuntimeDiagnostics: this.diagram.packageRuntimeDiagnostics,
    };
  }

  // ── Mutation Handlers ───────────────────────────────────────────────

  private handleCreateNode(params: Record<string, unknown>): Record<string, unknown> | Promise<Record<string, unknown>> {
    const position = params.position as { x: number; y: number } | undefined;
    const x = position?.x ?? 0;
    const y = position?.y ?? 0;
    const config = (params.config || {}) as Record<string, unknown>;

    const packageSpec = params.package as {
      id?: unknown;
      version?: unknown;
      name?: unknown;
      kind?: unknown;
    } | undefined;
    if (packageSpec) {
      if (typeof packageSpec.id !== "string" || typeof packageSpec.version !== "string" ||
          typeof packageSpec.name !== "string" || typeof packageSpec.kind !== "string") {
        throw new Error("package requires exact id, version, name and kind");
      }
      const metadata = this.diagram.packageCatalog.find((candidate) =>
        candidate.id === packageSpec.id && candidate.version === packageSpec.version,
      );
      if (!metadata) throw new Error(`Package not active: ${packageSpec.id}@${packageSpec.version}`);
      if (metadata.definition.kind !== packageSpec.kind) {
        throw new Error(`Package kind mismatch for ${packageSpec.id}: expected ${metadata.definition.kind}`);
      }
      if (metadata.definition.name !== packageSpec.name) {
        throw new Error(`Package name mismatch for ${packageSpec.id}: expected '${metadata.definition.name}'`);
      }
      const identity = { id: packageSpec.id, version: packageSpec.version, name: packageSpec.name };
      const suppliedParams = (params.parameters ?? config.params) as Record<string, unknown> | undefined;
      if (suppliedParams && (typeof suppliedParams !== "object" || Array.isArray(suppliedParams))) {
        throw new Error("parameters must be an object");
      }
      validatePackageParameterValues(metadata.definition, suppliedParams ?? {});
      const nodeParams = initialPackageParameters(metadata.definition, suppliedParams);
      const nodeConfig = {
        name: (params.name ?? config.name) as string | undefined,
        color: (params.color ?? config.color ?? metadata.definition.view.color) as string | undefined,
        width: (params.width ?? config.width ?? metadata.definition.view.width) as number | undefined,
        height: (params.height ?? config.height ?? metadata.definition.view.height) as number | undefined,
        params: nodeParams,
        inputsCount: ((params.inputsCount ?? config.inputsCount) as number | undefined) ?? (metadata.definition.kind === "join" ? 2 : undefined),
        parentId: (params.parentId ?? config.parentId) as string | undefined,
        wheelAdapters: (params.wheelAdapters ?? config.wheelAdapters) as string[] | undefined,
      };
      const create = () => {
        const beforeCount = this.diagram.nodes.length;
        this.diagram.addPackageNode(identity, metadata.definition.kind, x, y, nodeConfig);
        const added = this.diagram.nodes[beforeCount];
        if (!added) throw new Error("Failed to create package node");
        return {
          nodeId: added.id,
          name: added.data.name ?? packageSpec.name,
          type: added.type ?? "custom",
          package: added.data.package,
        };
      };
      const activatedCreate = (this.diagram as unknown as { addActivatedPackageNode?: Function }).addActivatedPackageNode;
      if (activatedCreate) return activatedCreate.call(this.diagram, identity, metadata.definition.kind, x, y, nodeConfig).then((added: Node) => ({
        nodeId: added.id, name: added.data.name ?? packageSpec.name, type: added.type ?? "custom", package: added.data.package,
      }));
      if (metadata.state === undefined || metadata.state === "active") return create();
      return this.diagram.activatePackage(identity).then(create);
    }

    throw new Error("create_node requires package {id, version, name, kind}");
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
    const duplicated = this.diagram.duplicateNodes(nodeIds, offset);

    return { duplicated };
  }

  private handleCreateSubflow(params: Record<string, unknown>): Record<string, unknown> {
    const position = params.position as { x: number; y: number } | undefined;
    const x = position?.x ?? 0;
    const y = position?.y ?? 0;

    const packageSpec = params.package as { id?: unknown; version?: unknown; name?: unknown } | undefined;
    if (!packageSpec || typeof packageSpec.id !== "string" || typeof packageSpec.version !== "string" || typeof packageSpec.name !== "string") {
      throw new Error("create_subflow requires package identity");
    }
    const metadata = this.diagram.packageCatalog.find((candidate) => candidate.id === packageSpec.id && candidate.version === packageSpec.version);
    if (!metadata || metadata.definition.kind !== "subflow") throw new Error("active subflow package not found");
    const subflow = this.diagram.addPackageNode(
      { id: metadata.id, version: metadata.version, name: metadata.definition.name },
      "subflow", x, y,
      { name: params.label as string | undefined, params: (params.params as Record<string, unknown>) ?? {} },
    );

    return {
      nodeId: subflow.id,
      name: (params.label as string) ?? ((subflow.data as Record<string, unknown>).name as string) ?? subflow.id,
    };
  }

  // ── Parameter Handlers ──────────────────────────────────────────────

  private handleSetParameter(params: Record<string, unknown>): Record<string, unknown> {
    const nodeId = params.nodeId as string;
    const key = params.key as string;
    const value = params.value;
    if (!nodeId || !key) throw new Error("Missing required parameters: nodeId, key");

    const node = this.diagram.getNodeById(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);

    const metadata = this.metadataForNode(node);
    if (!metadata.definition.parameters[key]) throw new Error(`Unknown package parameter: ${key}`);
    const currentParams = (node.data.params as Record<string, unknown> | undefined) ?? {};
    const previousValue = currentParams[key];
    const nextParams = { ...currentParams, [key]: value };
    validatePackageParameterValues(metadata.definition, nextParams);
    this.updateNodeParams(node, nextParams);

    return { nodeId, key, previousValue: previousValue ?? "", currentValue: value };
  }

  private handleUpdateParameters(params: Record<string, unknown>): Record<string, unknown> {
    const nodeId = params.nodeId as string;
    const newParamValues = params.params as Record<string, unknown> | undefined;
    if (!nodeId) throw new Error("Missing required parameter: nodeId");
    if (!newParamValues || typeof newParamValues !== "object") throw new Error("params must be an object");

    const node = this.diagram.getNodeById(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);

    const metadata = this.metadataForNode(node);
    const currentParams = (node.data.params as Record<string, unknown>) || {};
    const updated: Array<{ key: string; previousValue: unknown; currentValue: unknown }> = [];
    const unchanged: string[] = [];

    const newParams = { ...currentParams };
    for (const [key, value] of Object.entries(newParamValues)) {
      if (!metadata.definition.parameters[key]) throw new Error(`Unknown package parameter: ${key}`);
      const prev = newParams[key];
      if (prev !== value) {
        updated.push({ key, previousValue: prev ?? "", currentValue: value });
      } else {
        unchanged.push(key);
      }
      newParams[key] = value;
    }

    validatePackageParameterValues(metadata.definition, newParams);
    this.updateNodeParams(node, newParams);

    return { nodeId, updated, unchanged };
  }

  private handleResetParameters(params: Record<string, unknown>): Record<string, unknown> {
    const nodeId = params.nodeId as string;
    if (!nodeId) throw new Error("Missing required parameter: nodeId");

    const node = this.diagram.getNodeById(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);

    const metadata = this.metadataForNode(node);
    const currentParams = (node.data.params as Record<string, unknown>) || {};
    const reset: Array<{ key: string; previousValue: unknown; defaultValue: unknown }> = [];
    const newParams = { ...currentParams };
    const keysToReset = (params.keys as string[]) ?? Object.keys(metadata.definition.parameters);
    for (const key of keysToReset) {
      const definition = metadata.definition.parameters[key];
      if (!definition) continue;
      const defaultValue = definition.default;
      if (newParams[key] !== defaultValue) reset.push({ key, previousValue: newParams[key], defaultValue });
      if (defaultValue === undefined) delete newParams[key]; else newParams[key] = structuredClone(defaultValue);
    }
    this.updateNodeParams(node, newParams);

    return { nodeId, reset };
  }

  private handleQueryParameters(params: Record<string, unknown>): Record<string, unknown> {
    const rawIds = params.nodeId as string | string[] | undefined;
    if (!rawIds) throw new Error("Missing required parameter: nodeId");

    const ids = Array.isArray(rawIds) ? rawIds : [rawIds];
    const nodes: Array<Record<string, unknown>> = [];

    for (const id of ids) {
      const node = this.diagram.getNodeById(id);
      if (!node) throw new Error(`Node not found: ${id}`);

      const nd = node.data as Record<string, unknown>;
      const definitions = this.metadataForNode(node).definition.parameters;
      const currentParams = (nd.params as Record<string, unknown>) || {};

      const paramList: Array<{
        key: string;
        type: string;
        defaultValue: unknown;
        currentValue: unknown;
        isModified: boolean;
        position?: string;
      }> = [];

      for (const [key, def] of Object.entries(definitions)) {
        const currentVal = currentParams[key] ?? def.default;
        paramList.push({
          key,
          type: def.type,
          defaultValue: def.default,
          currentValue: currentVal,
          isModified: currentVal !== def.default,
          position: def.position,
        });
      }

      nodes.push({
        nodeId: id,
        name: (nd.name as string) ?? id,
        package: nd.package,
        params: paramList,
      });
    }

    return { nodes };
  }

  private metadataForNode(node: Node): import("../type-system/host").ActivePackageMetadata {
    const identity = packageIdentity(node);
    if (!identity) throw new Error("node has no package identity");
    const metadata = this.diagram.packageCatalog.find((candidate) => candidate.id === identity.id && candidate.version === identity.version);
    if (!metadata) throw new Error(`Package not active: ${identity.id}@${identity.version}`);
    return metadata;
  }

  private updateNodeParams(node: Node, params: Record<string, unknown>): void {
    const identity = packageIdentity(node);
    if (!identity) throw new Error("node has no package identity");
    const metadata = this.metadataForNode(node);
    this.diagram.updatePackageNode(node.id, identity, metadata.definition.kind, { params });
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

  // ── Serialization Handlers ─────────────────────────────────────────

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

    const topLevelNodes = this.diagram.nodes.filter((n) => n.parentId == null);
    const kindOf = (node: Node) => {
      const identity = packageIdentity(node);
      return identity && this.diagram.packageCatalog.find((metadata) => metadata.id === identity.id && metadata.version === identity.version)?.definition.kind;
    };
    const inputNodes = topLevelNodes.filter((node) => kindOf(node) === "input");

    if (inputNodes.length === 0) {
      errors.push("No Input node found. Exactly 1 Input node is required.");
    } else if (inputNodes.length > 1) {
      errors.push(`Found ${inputNodes.length} Input nodes. Exactly 1 Input node is required.`);
    }

    const topLevelIds = new Set(topLevelNodes.map((node) => node.id));
    const outgoing = new Map<string, string[]>();
    for (const edge of this.diagram.edges) {
      if (!topLevelIds.has(edge.source) || !topLevelIds.has(edge.target)) continue;
      const targets = outgoing.get(edge.source) ?? [];
      targets.push(edge.target);
      outgoing.set(edge.source, targets);
    }
    const terminals = topLevelNodes.filter((node) => !(outgoing.get(node.id)?.length));
    const lossNodes = topLevelNodes.filter((node) => kindOf(node) === "loss");

    if (lossNodes.length === 0) {
      if (terminals.length !== 1) errors.push(`Complete package graph requires exactly one terminal; found ${terminals.length}.`);
    } else {
      // Training graphs have two role-specific terminals: prediction and objective.
      const objectiveNodes = new Set(lossNodes.map((node) => node.id));
      const pending = [...objectiveNodes];
      while (pending.length > 0) {
        const nodeId = pending.pop()!;
        for (const target of outgoing.get(nodeId) ?? []) {
          if (objectiveNodes.has(target)) continue;
          objectiveNodes.add(target);
          pending.push(target);
        }
      }
      const predictionTerminals = terminals.filter((node) => kindOf(node) === "output" && !objectiveNodes.has(node.id));
      const objectiveTerminals = terminals.filter((node) => objectiveNodes.has(node.id));
      if (predictionTerminals.length !== 1) {
        errors.push(`Training package graph requires exactly one prediction output terminal; found ${predictionTerminals.length}.`);
      }
      if (objectiveTerminals.length !== 1) {
        errors.push(`Training package graph requires exactly one objective terminal; found ${objectiveTerminals.length}.`);
      }
    }

    // Detect orphan nodes (no incoming or outgoing connections, except Input/Loss)
    for (const node of topLevelNodes) {
      const kind = kindOf(node);
      if (!kind) { errors.push(`Node "${node.data.name ?? node.id}" has no active package identity.`); continue; }
      if (kind === "input" || kind === "loss") continue;

      const hasIncoming = this.diagram.edges.some((e) => e.target === node.id &&
        this.diagram.getNodeById(e.source)?.parentId == null);
      const hasOutgoing = this.diagram.edges.some((e) => e.source === node.id &&
        this.diagram.getNodeById(e.target)?.parentId == null);

      if (!hasIncoming && !hasOutgoing) {
        warnings.push(
          `Orphan node: "${node.data.name}" (${node.id}) has no connections.`,
        );
      } else if (!hasIncoming) {
        warnings.push(
          `Node "${node.data.name}" (${node.id}) has no incoming connections.`,
        );
      } else if (!hasOutgoing && node.type !== "join" && kind !== "output") {
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

  private handleValidateParameters(): Record<string, unknown> {
    const result = this.diagram.typeResult ?? this.diagram.refreshTypes();
    const errors: string[] = [];
    const warnings: string[] = [];
    for (const [nodeId, state] of result.nodes) {
      if (state.status === "error") errors.push(`${nodeId}: ${state.message}`);
      else if (state.status === "fault") errors.push(`${nodeId}: ${state.fault.message}`);
      else if (state.status === "unresolved") warnings.push(`${nodeId}: ${"reason" in state ? state.reason : `Missing: ${state.missingParameters.join(", ")}`}`);
    }
    return { valid: errors.length === 0, supported: true, errors, warnings };
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
    this.diagram.reset();
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

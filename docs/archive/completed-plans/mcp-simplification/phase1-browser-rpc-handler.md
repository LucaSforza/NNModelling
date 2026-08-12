# Phase 1: Browser RPC Handler

## Objective
Replace `DiagramSyncClient.ts` (249 lines of delta-based sync) with `BrowserRPCHandler.ts` (~200 lines of request/response RPC) that handles MCP server queries against the browser's `DiagramCore`.

## Protocol Change

**Old** (delta sync): Server broadcasts `{type:"snapshot"|"delta", seq, ...}` → Client applies deltas to `$state.raw`

**New** (RPC): Server sends `{id:"1", method:"get_graph", params:{}}` → Client executes on DiagramCore → Client responds `{id:"1", result:{...}}`

## Files

| File | Action |
|---|---|
| `front-end/src/sync/BrowserRPCHandler.ts` | **CREATE** — new RPC handler |
| `front-end/src/sync/DiagramSyncClient.ts` | **DELETE** |
| `front-end/src/FlowCanvas.svelte` | **MODIFY** — swap import + $effect |

## Spec: BrowserRPCHandler.ts

```typescript
// front-end/src/sync/BrowserRPCHandler.ts
// Browser-side RPC handler. Receives method calls from the MCP server,
// executes them on the Diagram's DiagramCore, and returns results.
//
// Protocol:
//   Server → Client: { id: string, method: string, params?: unknown }
//   Client → Server: { id: string, result?: unknown } | { id: string, error: { message: string } }

import type { Diagram } from "../Diagram.svelte";
import { NNTree } from "../conversion/nnTree";

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

export class BrowserRPCHandler {
  private ws: WebSocket | null = null;
  private diagram: Diagram;
  private url: string;
  private reconnectDelay: number = 1000;
  private intentionalClose: boolean = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(diagram: Diagram, url?: string) {
    this.diagram = diagram;
    this.url = url ?? (import.meta.env.DEV
      ? `ws://${window.location.host}/ws`
      : `ws://localhost:9339`);
  }

  connect(): void {
    this.intentionalClose = false;
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.debug(`[RPCHandler] Connected to ${this.url}`);
      this.reconnectDelay = 1000;
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string) as RPCRequest;
        if (typeof msg.id !== "string" || typeof msg.method !== "string") return;
        this.handleRequest(msg);
      } catch (err) {
        console.error("[RPCHandler] Failed to parse message:", event.data);
      }
    };

    this.ws.onclose = () => {
      if (!this.intentionalClose) this.scheduleReconnect();
    };

    this.ws.onerror = (event: Event) => {
      console.error("[RPCHandler] WebSocket error:", event);
    };
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  // ── RPC Dispatch ─────────────────────────────────────────────────

  private handleRequest(req: RPCRequest): void {
    try {
      const result = this.executeMethod(req.method, req.params ?? {});
      this.send({ id: req.id, result });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      this.send({ id: req.id, error: { message } });
    }
  }

  private send(res: RPCResponse): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(res));
    }
  }

  // ── Method Implementations ───────────────────────────────────────

  private executeMethod(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      // ── Inspection ──
      case "get_graph":
        return { nodes: this.diagram.nodes, edges: this.diagram.edges };

      case "get_node": {
        const node = this.diagram.getNodeById(params.nodeId as string);
        if (!node) throw new Error(`Node '${params.nodeId}' not found`);
        return node;
      }

      case "get_edges": {
        const nodeId = params.nodeId as string | undefined;
        if (nodeId) {
          if (!this.diagram.getNodeById(nodeId)) throw new Error(`Node '${nodeId}' not found`);
          return { edges: this.diagram.edges.filter(e => e.source === nodeId || e.target === nodeId) };
        }
        return { edges: this.diagram.edges };
      }

      case "get_subflow": {
        const parentId = params.parentId as string;
        if (!this.diagram.getNodeById(parentId)) throw new Error(`Node '${parentId}' not found`);
        const subNodes = this.diagram.nodes.filter(n => n.parentId === parentId);
        const subIds = new Set(subNodes.map(n => n.id));
        const subEdges = this.diagram.edges.filter(e => subIds.has(e.source) && subIds.has(e.target));
        return { nodes: subNodes, edges: subEdges };
      }

      case "graph_statistics": {
        // See spec note below — statistics computed on browser side
        const { nodes, edges } = this.diagram;
        let moduleCount = 0, joinCount = 0, subflowCount = 0, inputCount = 0, lossCount = 0;
        for (const n of nodes) {
          if (n.type === "join") joinCount++;
          else if (n.type === "subflow") subflowCount++;
          else moduleCount++;
          const sn = (n.data as any)?.stereotype;
          const st = sn ? this.diagram.getStereotype(sn) : null;
          if (st?.isInput) inputCount++;
          if (st?.isLoss) lossCount++;
        }
        return { nodeCount: nodes.length, edgeCount: edges.length, moduleCount, joinCount, subflowCount, inputCount, lossCount };
      }

      case "list_stereotypes": {
        const all = this.diagram.stereotypes ?? [];
        const category = params.category as string | undefined;
        const filtered = category ? all.filter(s => s.category === category) : all;
        return { stereotypes: filtered.map(s => ({ name: s.name, category: s.category, pythonClassName: s.pythonClassName, isJoin: s.isJoin, isInput: s.isInput, isLoss: s.isLoss, isSubFlow: s.isSubFlow, parameters: s.parameters })) };
      }

      // ── Mutations ──
      case "create_node": {
        const pos = params.position as { x: number; y: number };
        const cfg = (params.config || {}) as Record<string, unknown>;
        const stereo = this.diagram.getStereotype(params.stereotype as string);
        if (!stereo) throw new Error(`Stereotype '${params.stereotype}' not found`);
        const prevLen = this.diagram.nodes.length;
        if (stereo.isJoin) {
          this.diagram.addJoinNode(stereo, pos.x, pos.y, { name: cfg.name as string, color: cfg.color as string, inputsCount: (cfg.inputsCount as number) ?? 2, params: (cfg.params as Record<string, string>) ?? {} });
        } else {
          this.diagram.addModule(stereo, pos.x, pos.y, { name: cfg.name as string, color: cfg.color as string, width: cfg.width as number, height: cfg.height as number, params: (cfg.params as Record<string, string>) ?? {} });
        }
        const created = this.diagram.nodes[this.diagram.nodes.length - 1];
        return { nodeId: created.id, name: (created.data as any)?.name ?? params.stereotype, type: created.type ?? "custom", stereotype: params.stereotype };
      }

      case "delete_nodes": {
        const ids = params.nodeIds as string[];
        for (const id of ids) { if (!this.diagram.getNodeById(id)) throw new Error(`Node '${id}' not found`); }
        const beforeEdges = this.diagram.edges.filter(e => ids.includes(e.source) || ids.includes(e.target)).map(e => e.id);
        this.diagram.deleteNodes(ids);
        return { deletedNodeIds: ids, deletedEdgeIds: beforeEdges, reparentedNodes: [] };
      }

      case "connect_nodes": {
        const { source, target, sourceHandle, targetHandle } = params as Record<string, string | undefined>;
        if (!this.diagram.getNodeById(source!)) throw new Error(`Node '${source}' not found`);
        if (!this.diagram.getNodeById(target!)) throw new Error(`Node '${target}' not found`);
        const edge = this.diagram.addEdge(source!, target!, sourceHandle ?? undefined, targetHandle ?? undefined);
        return { edgeId: edge.id, source: edge.source, target: edge.target };
      }

      case "disconnect_nodes": {
        const { source, target, targetHandle } = params as Record<string, string | undefined>;
        const matching = this.diagram.edges.filter(e => e.source === source && e.target === target && (targetHandle === undefined || e.targetHandle === targetHandle));
        if (matching.length === 0) throw new Error(`No edge from '${source}' to '${target}'`);
        const removedIds = matching.map(e => e.id);
        this.diagram.removeEdge(source!, target!, targetHandle ?? undefined);
        return { removedEdgeIds: removedIds };
      }

      case "move_nodes": {
        const positions = params.positions as Array<{ id: string; x: number; y: number }>;
        for (const p of positions) { if (!this.diagram.getNodeById(p.id)) throw new Error(`Node '${p.id}' not found`); }
        this.diagram.moveNodes(positions);
        return { movedCount: positions.length };
      }

      case "duplicate_nodes": {
        const ids = params.nodeIds as string[];
        const offset = (params.offset as { x: number; y: number }) ?? { x: 50, y: 50 };
        const originals = ids.map(id => this.diagram.getNodeById(id)).filter(Boolean) as any[];
        const duplicated: Array<{ originalId: string; newId: string }> = [];
        const idMap = new Map<string, string>();
        for (const node of originals) {
          if (node.type === "subflow") continue;
          const sn = (node.data as any)?.stereotype;
          if (!sn) continue;
          const stereo = this.diagram.getStereotype(sn);
          if (!stereo) continue;
          const prevLen = this.diagram.nodes.length;
          if (stereo.isJoin) {
            this.diagram.addJoinNode(stereo, node.position.x + offset.x, node.position.y + offset.y, { name: (node.data as any)?.name, color: (node.data as any)?.color, inputsCount: (node.data as any)?.inputsCount, params: (node.data as any)?.params });
          } else {
            this.diagram.addModule(stereo, node.position.x + offset.x, node.position.y + offset.y, { name: (node.data as any)?.name, color: (node.data as any)?.color, width: node.width, height: node.height, params: (node.data as any)?.params });
          }
          if (this.diagram.nodes.length > prevLen) {
            const nn = this.diagram.nodes[this.diagram.nodes.length - 1];
            idMap.set(node.id, nn.id);
            duplicated.push({ originalId: node.id, newId: nn.id });
          }
        }
        for (const e of this.diagram.edges) {
          if (idMap.has(e.source) && idMap.has(e.target)) {
            this.diagram.addEdge(idMap.get(e.source)!, idMap.get(e.target)!, e.sourceHandle ?? undefined, e.targetHandle ?? undefined);
          }
        }
        return { duplicated };
      }

      case "create_subflow": {
        const pos = params.position as { x: number; y: number };
        const prevLen = this.diagram.nodes.length;
        this.diagram.addSubGraph(pos.x, pos.y);
        const created = this.diagram.nodes[this.diagram.nodes.length - 1];
        if (params.label) {
          this.diagram.updateModule(created.id, { name: params.label as string, label: params.label as string });
        }
        return { nodeId: created.id, name: (created.data as any)?.name ?? created.id };
      }

      // ── Parameters ──
      case "set_parameter": {
        const { nodeId, key, value } = params as Record<string, string>;
        const node = this.diagram.getNodeById(nodeId);
        if (!node) throw new Error(`Node '${nodeId}' not found`);
        const currentParams = (node.data as any)?.params ?? {};
        const previousValue = currentParams[key] ?? null;
        this.diagram.updateModule(nodeId, { params: { ...currentParams, [key]: value } });
        return { nodeId, key, previousValue, currentValue: value };
      }

      case "update_parameters": {
        const { nodeId, params: newParams } = params as { nodeId: string; params: Record<string, string> };
        const node = this.diagram.getNodeById(nodeId);
        if (!node) throw new Error(`Node '${nodeId}' not found`);
        const currentParams: Record<string, unknown> = (node.data as any)?.params ?? {};
        const updated: Array<{ key: string; previousValue: string; currentValue: string }> = [];
        for (const [k, v] of Object.entries(newParams)) {
          const prev = (currentParams[k] as string) ?? "";
          if (prev !== v) updated.push({ key: k, previousValue: prev, currentValue: v });
        }
        this.diagram.updateModule(nodeId, { params: { ...currentParams, ...newParams } });
        return { nodeId, updated, unchanged: Object.keys(newParams).filter(k => !updated.find(u => u.key === k)) };
      }

      case "reset_parameters": {
        const { nodeId, keys } = params as { nodeId: string; keys?: string[] };
        const node = this.diagram.getNodeById(nodeId);
        if (!node) throw new Error(`Node '${nodeId}' not found`);
        const sn = (node.data as any)?.stereotype;
        const stereo = sn ? this.diagram.getStereotype(sn) : null;
        const currentParams: Record<string, unknown> = (node.data as any)?.params ?? {};
        const reset: Array<{ key: string; previousValue: string; defaultValue: string }> = [];
        if (!stereo) {
          // Clear all
          for (const k of Object.keys(currentParams)) reset.push({ key: k, previousValue: (currentParams[k] as string) ?? "", defaultValue: "" });
          this.diagram.updateModule(nodeId, { params: {} });
        } else {
          const updated = { ...currentParams };
          const toReset = keys ?? Object.keys(stereo.parameters);
          for (const k of toReset) {
            const def = stereo.parameters[k];
            if (!def) continue;
            reset.push({ key: k, previousValue: (currentParams[k] as string) ?? def.default, defaultValue: def.default });
            updated[k] = def.default;
          }
          this.diagram.updateModule(nodeId, { params: updated });
        }
        return { nodeId, reset };
      }

      case "query_parameters": {
        const nodeIds: string[] = Array.isArray(params.nodeId) ? params.nodeId as string[] : [params.nodeId as string];
        const nodes = nodeIds.map(nid => {
          const node = this.diagram.getNodeById(nid);
          if (!node) throw new Error(`Node '${nid}' not found`);
          const nd = node.data as any;
          const sn = nd?.stereotype;
          const stereo = sn ? this.diagram.getStereotype(sn) : null;
          const currentRaw: Record<string, unknown> = nd?.params ?? {};
          const paramDefs = stereo?.parameters ?? {};
          const params = Object.entries(paramDefs).map(([key, pd]) => {
            const cv = (currentRaw[key] as string) ?? pd.default;
            return { key, value: cv, type: pd.type, default: pd.default, position: pd.position as string | undefined, isModified: cv !== pd.default };
          });
          // Add custom params not in stereotype
          for (const [k, v] of Object.entries(currentRaw)) {
            if (!paramDefs[k]) params.push({ key: k, value: String(v ?? ""), type: "string", default: "", position: undefined, isModified: true });
          }
          return { nodeId: nid, name: nd?.name ?? nid, stereotype: sn ?? "unknown", params };
        });
        return { nodes };
      }

      // ── Selection ──
      case "select_nodes": {
        const { nodeIds, mode } = params as { nodeIds: string[]; mode?: string };
        for (const id of nodeIds) { if (!this.diagram.getNodeById(id)) throw new Error(`Node '${id}' not found`); }
        let finalIds: string[];
        if (mode === "add") {
          finalIds = [...new Set([...this.diagram.getSelectedNodes().map(n => n.id), ...nodeIds])];
        } else if (mode === "remove") {
          finalIds = this.diagram.getSelectedNodes().map(n => n.id).filter(id => !nodeIds.includes(id));
        } else {
          finalIds = nodeIds;
        }
        this.diagram.selectNodes(finalIds);
        return { selectedNodeIds: finalIds, selectedEdgeIds: this.diagram.getSelectedEdges().map(e => e.id) };
      }

      case "clear_selection":
        this.diagram.clearSelection();
        return { cleared: true };

      case "get_selection": {
        const selNodes = this.diagram.getSelectedNodes();
        const selEdges = this.diagram.getSelectedEdges();
        return { nodeIds: selNodes.map(n => n.id), edgeIds: selEdges.map(e => e.id), nodes: selNodes, edges: selEdges };
      }

      case "select_all": {
        const allIds = this.diagram.nodes.map(n => n.id);
        this.diagram.selectNodes(allIds);
        return { nodeCount: allIds.length };
      }

      // ── Compilation / Serialization ──
      case "compile_nntree": {
        const nntree = new NNTree(this.diagram as any);
        const json = nntree.toJson();
        let subflowCount = 0;
        for (const [, node] of nntree.nodes) { if (node.isSubflow()) subflowCount++; }
        return { json, root: nntree.root, nodeCount: nntree.nodes.size, subflowCount, lossNodeType: nntree.lossNode?.stereotype ?? null };
      }

      case "export_diagram": {
        const json = this.diagram.exportToJson();
        return { json, nodeCount: this.diagram.nodes.length, edgeCount: this.diagram.edges.length };
      }

      case "import_diagram": {
        const json = params.json as string;
        let parsed: any;
        try { parsed = JSON.parse(json); } catch { throw new Error("Invalid JSON"); }
        if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) throw new Error("JSON must contain nodes and edges arrays");
        this.diagram.importFromJson(json);
        return { nodeCount: this.diagram.nodes.length, edgeCount: this.diagram.edges.length };
      }

      // ── Validation ──
      case "validate_graph": {
        const errors: string[] = [];
        const warnings: string[] = [];
        const inputNodes = this.diagram.nodes.filter(n => (n.data as any)?.stereotype === "Input");
        if (inputNodes.length === 0) errors.push("No Input node found");
        if (inputNodes.length > 1) errors.push(`Multiple Input nodes (${inputNodes.length}) found`);
        const lossNodes = this.diagram.nodes.filter(n => this.diagram.getStereotype((n.data as any)?.stereotype)?.isLoss);
        if (lossNodes.length === 0) errors.push("No loss/output node found");
        // Orphan check
        const connectedIds = new Set<string>();
        for (const e of this.diagram.edges) { connectedIds.add(e.source); connectedIds.add(e.target); }
        const orphans = this.diagram.nodes.filter(n => !connectedIds.has(n.id) && (n.data as any)?.stereotype !== "Input");
        for (const o of orphans) warnings.push(`Orphan node: ${o.id}`);
        return { valid: errors.length === 0, errors, warnings };
      }

      // ── Lifecycle ──
      case "reset_diagram":
        this.diagram.nodes = [];
        this.diagram.edges = [];
        return { success: true, message: "Diagram reset to empty state" };

      case "ping":
        return { status: "ok", uptime: performance.now() / 1000, nodeCount: this.diagram.nodes.length, edgeCount: this.diagram.edges.length, activeTransaction: null };

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  // ── Reconnection ──
  private scheduleReconnect(): void {
    const delay = this.reconnectDelay;
    console.debug(`[RPCHandler] Reconnecting in ${delay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30000);
      this.connect();
    }, delay);
  }
}
```

## Spec: FlowCanvas.svelte changes

1. Line 35: Change import from `DiagramSyncClient` to `BrowserRPCHandler`
2. Lines 71-78: Replace `$effect` block — remove `push_state` behavior, just connect
3. Line 72: Type annotation changes to `BrowserRPCHandler`

```svelte
// OLD (line 35):
import { DiagramSyncClient } from "./sync/DiagramSyncClient";

// NEW:
import { BrowserRPCHandler } from "./sync/BrowserRPCHandler";

// OLD (lines 72-78):
let syncClient: DiagramSyncClient;
$effect(() => {
  syncClient = new DiagramSyncClient(diagram);
  syncClient.connect();
  return () => syncClient.disconnect();
});

// NEW:
let syncClient: BrowserRPCHandler;
$effect(() => {
  syncClient = new BrowserRPCHandler(diagram);
  syncClient.connect();
  return () => syncClient.disconnect();
});
```

## Test Plan
- Verify FlowCanvas.svelte compiles (no type errors)
- Verify BrowserRPCHandler connects to WebSocket (manual with MCP server)
- Existing unit tests should still pass (DiagramSyncClient test file kept until Phase 6)

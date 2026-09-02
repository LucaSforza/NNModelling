/**
 * MCP Tool Tests — mock BrowserRPCClient
 *
 * Tests that each tool handler correctly delegates to the browser's
 * BrowserRPCClient.call() with the expected method name and params,
 * and passes through the result.
 *
 * Every test creates a fresh mock BrowserRPCClient and ServerContext,
 * ensuring isolation between test cases.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs/promises";
import type { ServerContext } from "../src/server";
import type { BrowserRPCClient } from "../src/browser-client";

// Import tool modules
import * as graphTools from "../src/tools/graph";
import * as paramTools from "../src/tools/parameters";
import * as selectionTools from "../src/tools/selection";
import * as canvasTools from "../src/tools/canvas";
import * as conversionTools from "../src/tools/conversion";
import * as inspectionTools from "../src/tools/inspection";
import * as lifecycleTools from "../src/tools/lifecycle";
import * as validationTools from "../src/tools/validation";
import * as connectionTools from "../src/tools/connection";
import * as projectTools from "../src/tools/project";

// ── Test Helper ─────────────────────────────────────────────────────────

function createMockBrowser(): BrowserRPCClient {
  const mock = {
    call: vi.fn().mockResolvedValue({}),
    isConnected: vi.fn().mockReturnValue(true),
    start: vi.fn(),
    close: vi.fn(),
    getTabs: vi.fn().mockReturnValue([]),
    selectTab: vi.fn(),
    getActiveTabId: vi.fn().mockReturnValue(null),
  };
  return mock as unknown as BrowserRPCClient;
}

function createTestContext(): ServerContext {
  return {
    browser: createMockBrowser(),
    projectRoot: "/tmp",
    projectPaths: new Map(),
  };
}

describe("project tools", () => {
  it("validates and forwards an explicit project path without exposing handles", async () => {
    const ctx = createTestContext();
    const parent = await fs.mkdtemp("/tmp/nnm-project-");
    const input = { projectPath: `${parent}/demo`, id: "demo", version: "0.1.0", name: "Demo" };
    try {
      const result = await projectTools.create_project.handler(ctx, input);
      expect(ctx.browser.call).toHaveBeenCalledWith("create_project", expect.objectContaining({ projectPath: input.projectPath, modelJson: expect.any(String), resources: expect.any(Object) }));
      expect(result).toEqual({});
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("rejects paths outside the configured root before browser RPC", async () => {
    const ctx = createTestContext();
    await expect(projectTools.open_project.handler({ ...ctx, projectRoot: "/tmp/projects" }, { projectPath: "/tmp/other/demo" })).rejects.toThrow("inside");
    expect(ctx.browser.call).not.toHaveBeenCalled();
  });

  it("rolls back only the directory created when activation fails", async () => {
    const parent = await fs.mkdtemp("/tmp/nnm-project-");
    const ctx = createTestContext();
    (ctx.browser.call as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("activation failed"));
    try {
      await expect(projectTools.create_project.handler(ctx, { projectPath: `${parent}/demo`, id: "demo", version: "0.1.0", name: "Demo" })).rejects.toThrow("activation failed");
      await expect(fs.stat(`${parent}/demo`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
});

// ── Graph Tools ─────────────────────────────────────────────────────────

describe("graph tools", () => {
  let ctx: ServerContext;
  let mockBrowser: BrowserRPCClient;

  beforeEach(() => {
    ctx = createTestContext();
    mockBrowser = ctx.browser;
  });

  it("create_node calls browser with correct method and params", async () => {
    const expectedResult = { nodeId: "n1", type: "custom", stereotype: "Linear" };
    (mockBrowser.call as ReturnType<typeof vi.fn>).mockResolvedValue(expectedResult);

    const input = {
      stereotype: "Linear",
      position: { x: 100, y: 50 },
      config: { params: { in_features: "784", out_features: "128" } },
    };
    const result = await graphTools.create_node.handler(ctx, input);

    expect(mockBrowser.call).toHaveBeenCalledWith("create_node", input);
    expect(result).toEqual(expectedResult);
  });

  it("delete_nodes calls browser with correct method and params", async () => {
    const expectedResult = { deletedNodeIds: ["n1"], deletedEdgeIds: ["e1"] };
    (mockBrowser.call as ReturnType<typeof vi.fn>).mockResolvedValue(expectedResult);

    const input = { nodeIds: ["n1"] };
    const result = await graphTools.delete_nodes.handler(ctx, input);

    expect(mockBrowser.call).toHaveBeenCalledWith("delete_nodes", input);
    expect(result).toEqual(expectedResult);
  });

  it("connect_nodes calls browser with correct method and params", async () => {
    const expectedResult = { edgeId: "e1", source: "n1", target: "n2" };
    (mockBrowser.call as ReturnType<typeof vi.fn>).mockResolvedValue(expectedResult);

    const input = { source: "n1", target: "n2" };
    const result = await graphTools.connect_nodes.handler(ctx, input);

    expect(mockBrowser.call).toHaveBeenCalledWith("connect_nodes", input);
    expect(result).toEqual(expectedResult);
  });

  it("disconnect_nodes calls browser with correct method and params", async () => {
    const expectedResult = { removedEdgeIds: ["e1"] };
    (mockBrowser.call as ReturnType<typeof vi.fn>).mockResolvedValue(expectedResult);

    const input = { source: "n1", target: "n2" };
    const result = await graphTools.disconnect_nodes.handler(ctx, input);

    expect(mockBrowser.call).toHaveBeenCalledWith("disconnect_nodes", input);
    expect(result).toEqual(expectedResult);
  });

  it("move_nodes calls browser with correct method and params", async () => {
    const expectedResult = { movedNodeIds: ["n1"] };
    (mockBrowser.call as ReturnType<typeof vi.fn>).mockResolvedValue(expectedResult);

    const input = { positions: [{ id: "n1", x: 200, y: 300 }] };
    const result = await graphTools.move_nodes.handler(ctx, input);

    expect(mockBrowser.call).toHaveBeenCalledWith("move_nodes", input);
    expect(result).toEqual(expectedResult);
  });
});

// ── Parameter Tools ─────────────────────────────────────────────────────

describe("parameter tools", () => {
  let ctx: ServerContext;
  let mockBrowser: BrowserRPCClient;

  beforeEach(() => {
    ctx = createTestContext();
    mockBrowser = ctx.browser;
  });

  it("set_parameter calls browser with correct method and params", async () => {
    const expectedResult = { nodeId: "n1", key: "out_features", previousValue: "128", currentValue: "256" };
    (mockBrowser.call as ReturnType<typeof vi.fn>).mockResolvedValue(expectedResult);

    const input = { nodeId: "n1", key: "out_features", value: "256" };
    const result = await paramTools.set_parameter.handler(ctx, input);

    expect(mockBrowser.call).toHaveBeenCalledWith("set_parameter", input);
    expect(result).toEqual(expectedResult);
  });

  it("update_parameters calls browser with correct method and params", async () => {
    const expectedResult = { nodeId: "n1", updatedKeys: ["in_features", "out_features"] };
    (mockBrowser.call as ReturnType<typeof vi.fn>).mockResolvedValue(expectedResult);

    const input = { nodeId: "n1", params: { in_features: "512", out_features: "256" } };
    const result = await paramTools.update_parameters.handler(ctx, input);

    expect(mockBrowser.call).toHaveBeenCalledWith("update_parameters", input);
    expect(result).toEqual(expectedResult);
  });
});

// ── Selection Tools ─────────────────────────────────────────────────────

describe("selection tools", () => {
  let ctx: ServerContext;
  let mockBrowser: BrowserRPCClient;

  beforeEach(() => {
    ctx = createTestContext();
    mockBrowser = ctx.browser;
  });

  it("select_nodes calls browser with correct method and params", async () => {
    const expectedResult = { selectedNodeIds: ["n1", "n2"] };
    (mockBrowser.call as ReturnType<typeof vi.fn>).mockResolvedValue(expectedResult);

    const input = { nodeIds: ["n1", "n2"], mode: "replace" };
    const result = await selectionTools.select_nodes.handler(ctx, input);

    expect(mockBrowser.call).toHaveBeenCalledWith("select_nodes", input);
    expect(result).toEqual(expectedResult);
  });

  it("clear_selection calls browser with correct method and params", async () => {
    const expectedResult = { cleared: true };
    (mockBrowser.call as ReturnType<typeof vi.fn>).mockResolvedValue(expectedResult);

    const result = await selectionTools.clear_selection.handler(ctx, {});

    expect(mockBrowser.call).toHaveBeenCalledWith("clear_selection", {});
    expect(result).toEqual(expectedResult);
  });
});

// ── Canvas Tools ────────────────────────────────────────────────────────

describe("canvas tools", () => {
  let ctx: ServerContext;
  let mockBrowser: BrowserRPCClient;

  beforeEach(() => {
    ctx = createTestContext();
    mockBrowser = ctx.browser;
  });

  it("get_canvas_state calls browser with correct method", async () => {
    const expectedResult = { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
    (mockBrowser.call as ReturnType<typeof vi.fn>).mockResolvedValue(expectedResult);

    const result = await canvasTools.get_canvas_state.handler(ctx, {});

    expect(mockBrowser.call).toHaveBeenCalledWith("get_canvas_state", {});
    expect(result).toEqual(expectedResult);
  });
});

// ── Inspection Tools ────────────────────────────────────────────────────

describe("inspection tools", () => {
  let ctx: ServerContext;
  let mockBrowser: BrowserRPCClient;

  beforeEach(() => {
    ctx = createTestContext();
    mockBrowser = ctx.browser;
  });

  it("get_graph calls browser with correct method", async () => {
    const expectedResult = { nodes: [], edges: [] };
    (mockBrowser.call as ReturnType<typeof vi.fn>).mockResolvedValue(expectedResult);

    const result = await inspectionTools.get_graph.handler(ctx, {});

    expect(mockBrowser.call).toHaveBeenCalledWith("get_graph", {});
    expect(result).toEqual(expectedResult);
  });

  it("get_node calls browser with correct method and params", async () => {
    const expectedResult = { id: "n1", type: "custom", data: { stereotype: "Linear" } };
    (mockBrowser.call as ReturnType<typeof vi.fn>).mockResolvedValue(expectedResult);

    const input = { nodeId: "n1" };
    const result = await inspectionTools.get_node.handler(ctx, input);

    expect(mockBrowser.call).toHaveBeenCalledWith("get_node", input);
    expect(result).toEqual(expectedResult);
  });

  it("get_type_info calls browser with optional node and refresh arguments", async () => {
    const expectedResult = {
      annotation: { nodeId: "n1", outputType: { shape: [], dtype: "float32" } },
      errors: [],
      warnings: [],
      suggestions: [],
    };
    (mockBrowser.call as ReturnType<typeof vi.fn>).mockResolvedValue(expectedResult);

    const input = { nodeId: "n1", refresh: true };
    const result = await inspectionTools.get_type_info.handler(ctx, input);

    expect(mockBrowser.call).toHaveBeenCalledWith("get_type_info", input);
    expect(result).toEqual(expectedResult);
  });

  it("graph_statistics calls browser with correct method", async () => {
    const expectedResult = { nodeCount: 5, edgeCount: 4, typeCounts: {} };
    (mockBrowser.call as ReturnType<typeof vi.fn>).mockResolvedValue(expectedResult);

    const result = await inspectionTools.graph_statistics.handler(ctx, {});

    expect(mockBrowser.call).toHaveBeenCalledWith("graph_statistics", {});
    expect(result).toEqual(expectedResult);
  });

  it("get_package_diagnostics is a stateless browser proxy", async () => {
    const expectedResult = {
      packageRuntimeReady: false,
      packageRuntimeDiagnostics: [{ occurrenceId: "runtime:one", severity: "fatal", phase: "activation", message: "one" }],
    };
    (mockBrowser.call as ReturnType<typeof vi.fn>).mockResolvedValue(expectedResult);

    const result = await inspectionTools.get_package_diagnostics.handler(ctx, {});

    expect(mockBrowser.call).toHaveBeenCalledWith("get_package_diagnostics", {});
    expect(result).toBe(expectedResult);
    expect(Object.keys(inspectionTools)).not.toContain("packageCatalog");
  });
});

// ── Validation Tools ────────────────────────────────────────────────────

describe("validation tools", () => {
  let ctx: ServerContext;
  let mockBrowser: BrowserRPCClient;

  beforeEach(() => {
    ctx = createTestContext();
    mockBrowser = ctx.browser;
  });

  it("validate_graph calls browser with correct method", async () => {
    const expectedResult = { valid: true, errors: [] };
    (mockBrowser.call as ReturnType<typeof vi.fn>).mockResolvedValue(expectedResult);

    const result = await validationTools.validate_graph.handler(ctx, {});

    expect(mockBrowser.call).toHaveBeenCalledWith("validate_graph", {});
    expect(result).toEqual(expectedResult);
  });

  it("validate_connections calls browser with correct method", async () => {
    const expectedResult = { valid: true, errors: [] };
    (mockBrowser.call as ReturnType<typeof vi.fn>).mockResolvedValue(expectedResult);

    const result = await validationTools.validate_connections.handler(ctx, {});

    expect(mockBrowser.call).toHaveBeenCalledWith("validate_connections", {});
    expect(result).toEqual(expectedResult);
  });
});

// ── Conversion Tools ────────────────────────────────────────────────────

describe("conversion tools", () => {
  let ctx: ServerContext;
  let mockBrowser: BrowserRPCClient;

  beforeEach(() => {
    ctx = createTestContext();
    mockBrowser = ctx.browser;
  });

  it("export_diagram calls browser with correct method", async () => {
    const expectedResult = { json: '{"nodes": [], "edges": []}' };
    (mockBrowser.call as ReturnType<typeof vi.fn>).mockResolvedValue(expectedResult);

    const result = await conversionTools.export_diagram.handler(ctx, {});

    expect(mockBrowser.call).toHaveBeenCalledWith("export_diagram", {});
    expect(result).toEqual(expectedResult);
  });

  it("import_diagram calls browser with correct method and params", async () => {
    const expectedResult = { imported: true, nodeCount: 3, edgeCount: 2 };
    (mockBrowser.call as ReturnType<typeof vi.fn>).mockResolvedValue(expectedResult);

    const input = { json: '{"nodes": [], "edges": []}' };
    const result = await conversionTools.import_diagram.handler(ctx, input);

    expect(mockBrowser.call).toHaveBeenCalledWith("import_diagram", input);
    expect(result).toEqual(expectedResult);
  });
});

// ── Lifecycle Tools ─────────────────────────────────────────────────────

describe("lifecycle tools", () => {
  let ctx: ServerContext;
  let mockBrowser: BrowserRPCClient;

  beforeEach(() => {
    ctx = createTestContext();
    mockBrowser = ctx.browser;
  });

  it("reset_diagram calls browser with correct method", async () => {
    const expectedResult = { reset: true };
    (mockBrowser.call as ReturnType<typeof vi.fn>).mockResolvedValue(expectedResult);

    const result = await lifecycleTools.reset_diagram.handler(ctx, {});

    expect(mockBrowser.call).toHaveBeenCalledWith("reset_diagram", {});
    expect(result).toEqual(expectedResult);
  });

  it("ping calls browser with correct method and returns result", async () => {
    const expectedResult = { status: "ok", nodeCount: 0, edgeCount: 0 };
    (mockBrowser.call as ReturnType<typeof vi.fn>).mockResolvedValue(expectedResult);

    const result = await lifecycleTools.ping.handler(ctx, {});

    expect(mockBrowser.call).toHaveBeenCalledWith("ping", {});
    expect(result).toEqual(expectedResult);
  });
});

// ── Connection Tools ──────────────────────────────────────────────────────

describe("connection tools", () => {
  let ctx: ServerContext;
  let mockBrowser: BrowserRPCClient;

  beforeEach(() => {
    ctx = createTestContext();
    mockBrowser = ctx.browser;
  });

  it("list_browser_tabs returns tabs and activeTabId", async () => {
    const mockTabs = [
      { id: "tab_1", nodeCount: 5, edgeCount: 4, connectedAt: 1000 },
      { id: "tab_2", nodeCount: 3, edgeCount: 2, connectedAt: 2000 },
    ];
    (mockBrowser.getTabs as ReturnType<typeof vi.fn>).mockReturnValue(mockTabs);
    (mockBrowser.getActiveTabId as ReturnType<typeof vi.fn>).mockReturnValue("tab_1");

    const result = await connectionTools.list_browser_tabs.handler(ctx, {});

    expect(result).toEqual({
      tabs: mockTabs,
      activeTabId: "tab_1",
    });
    expect(mockBrowser.getTabs).toHaveBeenCalled();
    expect(mockBrowser.getActiveTabId).toHaveBeenCalled();
  });

  it("select_browser_tab selects an existing tab", async () => {
    const mockTabs = [
      { id: "tab_1", nodeCount: 5, edgeCount: 4, connectedAt: 1000 },
      { id: "tab_2", nodeCount: 3, edgeCount: 2, connectedAt: 2000 },
    ];
    (mockBrowser.getTabs as ReturnType<typeof vi.fn>).mockReturnValue(mockTabs);

    const input = { tabId: "tab_2" };
    const result = await connectionTools.select_browser_tab.handler(ctx, input);

    expect(result).toEqual({ success: true, selectedTab: "tab_2" });
    expect(mockBrowser.selectTab).toHaveBeenCalledWith("tab_2");
  });

  it("select_browser_tab throws for unknown tab", async () => {
    (mockBrowser.getTabs as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "tab_1", nodeCount: 5, edgeCount: 4, connectedAt: 1000 },
    ]);

    const input = { tabId: "nonexistent" };
    await expect(
      connectionTools.select_browser_tab.handler(ctx, input),
    ).rejects.toThrow("Tab 'nonexistent' not found");

    expect(mockBrowser.selectTab).not.toHaveBeenCalled();
  });
});

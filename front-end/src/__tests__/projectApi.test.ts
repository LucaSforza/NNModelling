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

import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendApiError } from "../training/api";
import { ProjectApiClient, type ProjectSummary } from "../projects/api";
import { isLocalCompanionBackend, ProjectWorkspace } from "../projects/state.svelte";
import { loadBackendConnection, loadBackendConnectionByOrigin, saveBackendConnection } from "../training/connection";
import { compileStereotypeCatalog } from "../core/StereotypeCore";
import { Diagram } from "../Diagram.svelte";
import { stubWindow, unstubWindow } from "./helpers";

stubWindow();
afterEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => unstubWindow());

const PROJECT: ProjectSummary = {
  id: "proj-123",
  name: "my-model",
  root: "/home/me/projects/my-model",
  model: "model/graph.json",
  environment: { status: "ready", python: "/home/me/projects/my-model/.venv/bin/python", message: "", synced_at: "2026-08-02T00:00:00Z" },
  wandb: { entity: "", project: "NeuralNetworks", tags: [], run_name_template: "", mode: "online" },
  api_key_configured: false,
  last_opened: "2026-08-02T00:00:00Z",
  exists: true,
  metadata_valid: true,
  metadata_error: null,
};

const DIAGRAM_GRAPH = {
  nodes: [
    {
      id: "n1",
      type: "custom",
      position: { x: 0, y: 0 },
      data: { stereotype: "Input", name: "Input_0", color: "#ccc", params: {}, isInput: true, isLoss: false },
    },
  ],
  edges: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ detail: { code, message } }, status);
}

/** Router keyed by absolute URL (path only). Returns a Response or throws. */
type Route = (init?: RequestInit) => Response | Promise<Response>;

function mockFetch(routes: Record<string, Route>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | string, init?: RequestInit) => {
    const url = String(input);
    const route = routes[url];
    if (!route) throw new Error(`Unexpected fetch: ${url}`);
    return route(init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ProjectApiClient serialization", () => {
  it("creates a project with name and root through the authenticated API", async () => {
    const fetchMock = mockFetch({
      "http://companion.test/api/projects": () => jsonResponse(PROJECT, 201),
    });
    const api = new ProjectApiClient("http://companion.test/api", "secret-token");

    const created = await api.createProject("my-model", "/home/me/projects/my-model");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://companion.test/api/projects");
    expect(url).not.toContain("secret-token");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret-token");
    expect(JSON.parse(String(init.body))).toEqual({ name: "my-model", root: "/home/me/projects/my-model" });
    expect(created.id).toBe("proj-123");
  });

  it("opens an existing project by root path", async () => {
    const fetchMock = mockFetch({
      "http://companion.test/api/projects/open": () => jsonResponse(PROJECT),
    });
    const api = new ProjectApiClient("http://companion.test/api", "secret-token");

    await api.openProject("/home/me/projects/my-model");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ root: "/home/me/projects/my-model" });
  });

  it("lists recent projects with the active project first-class", async () => {
    const fetchMock = mockFetch({
      "http://companion.test/api/projects": () => jsonResponse({ active: PROJECT, projects: [PROJECT] }),
    });
    const api = new ProjectApiClient("http://companion.test/api", "secret-token");

    const response = await api.listProjects();

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("http://companion.test/api/projects");
    expect(response.active?.id).toBe("proj-123");
    expect(response.projects).toHaveLength(1);
  });

  it("treats a missing active project as null instead of an error", async () => {
    mockFetch({
      "http://companion.test/api/projects/active": () => errorResponse(404, "no_active_project", "no project is currently active"),
    });
    const api = new ProjectApiClient("http://companion.test/api", "secret-token");

    await expect(api.activeProject()).resolves.toBeNull();
  });

  it("reads and writes the project graph", async () => {
    const fetchMock = mockFetch({
      "http://companion.test/api/projects/proj-123/graph": (init) =>
        init?.method === "PUT" ? jsonResponse(DIAGRAM_GRAPH) : jsonResponse(DIAGRAM_GRAPH),
    });
    const api = new ProjectApiClient("http://companion.test/api", "secret-token");

    const read = await api.readGraph("proj-123");
    expect(read.nodes).toHaveLength(1);

    const written = await api.writeGraph("proj-123", DIAGRAM_GRAPH);
    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT") as [string, RequestInit];
    expect(JSON.parse(String(putCall[1].body))).toEqual(DIAGRAM_GRAPH);
    expect(written.nodes).toHaveLength(1);
  });

  it("fetches the runtime stereotype and dataset catalogs", async () => {
    const catalog = {
      stereotypes: [
        { id: "project-stereotypes/FancyLayer.json", name: "FancyLayer", source: "project", data: { category: "Layer" } },
      ],
      errors: [{ path: "project-stereotypes/Broken.json", error: "invalid" }],
    };
    mockFetch({
      "http://companion.test/api/projects/proj-123/stereotypes": () => jsonResponse(catalog),
      "http://companion.test/api/projects/proj-123/datasets": () =>
        jsonResponse({ datasets: [{ target: "dataset.x.MyDataset", name: "MyDataset" }], errors: [] }),
    });
    const api = new ProjectApiClient("http://companion.test/api", "secret-token");

    const stereotypes = await api.projectStereotypes("proj-123");
    expect(stereotypes.stereotypes[0].source).toBe("project");
    expect(stereotypes.errors[0].path).toBe("project-stereotypes/Broken.json");

    const datasets = await api.projectDatasets("proj-123");
    expect(datasets.datasets[0].target).toBe("dataset.x.MyDataset");
  });

  it("reads, updates, and stores W&B non-secret settings", async () => {
    const fetchMock = mockFetch({
      "http://companion.test/api/projects/proj-123/wandb": (init) =>
        init?.method === "PUT"
          ? jsonResponse({ ...PROJECT.wandb, entity: "team", api_key_configured: false })
          : jsonResponse({ ...PROJECT.wandb, api_key_configured: false }),
    });
    const api = new ProjectApiClient("http://companion.test/api", "secret-token");

    const read = await api.readWandb("proj-123");
    expect(read.project).toBe("NeuralNetworks");

    const updated = await api.updateWandb("proj-123", { entity: "team" });
    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT") as [string, RequestInit];
    expect(JSON.parse(String(putCall[1].body))).toEqual({ entity: "team" });
    expect(updated.entity).toBe("team");
  });

  it("stores and deletes the W&B API key write-only", async () => {
    const fetchMock = mockFetch({
      "http://companion.test/api/projects/proj-123/wandb-key": (init) =>
        init?.method === "DELETE" ? jsonResponse({ configured: false }) : jsonResponse({ configured: true }),
    });
    const api = new ProjectApiClient("http://companion.test/api", "secret-token");

    const stored = await api.setWandbKey("proj-123", "wandb-secret-key");
    expect(stored.configured).toBe(true);
    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method !== "DELETE") as [string, RequestInit];
    const [url] = putCall;
    const body = JSON.parse(String(putCall[1].body));
    expect(body).toEqual({ api_key: "wandb-secret-key" });
    expect(url).not.toContain("wandb-secret-key");

    const deleted = await api.deleteWandbKey("proj-123");
    expect(deleted.configured).toBe(false);
  });

  it("maps project error codes to typed errors", async () => {
    mockFetch({
      "http://companion.test/api/projects": () => errorResponse(409, "incompatible_root", "root is not empty"),
    });
    const api = new ProjectApiClient("http://companion.test/api", "secret-token");

    const error = await api.createProject("x", "/tmp/non-empty").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BackendApiError);
    const apiError = error as BackendApiError;
    expect(apiError.status).toBe(409);
    expect(apiError.code).toBe("incompatible_root");
    expect(apiError.message).toContain("root is not empty");
  });

  it("sends an anonymous request without an Authorization header when no token is configured", async () => {
    const fetchMock = mockFetch({
      "http://companion.test/api/projects": () => errorResponse(401, "missing_token", "no pairing token"),
    });
    const api = new ProjectApiClient("http://companion.test/api");

    await expect(api.listProjects()).rejects.toMatchObject<Partial<BackendApiError>>({
      status: 401,
      code: "missing_token",
    });

    // The client never invents or leaks a credential: without a token it
    // sends no Authorization header at all and surfaces the server rejection.
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("authorization")).toBeNull();
  });

  it("joins the base URL with request paths and tolerates a trailing slash", async () => {
    const fetchMock = mockFetch({
      "http://companion.test/api/projects": () => jsonResponse({ active: null, projects: [] }),
    });
    const api = new ProjectApiClient("http://companion.test/api/", "token");

    await api.listProjects();

    expect(fetchMock.mock.calls[0][0]).toBe("http://companion.test/api/projects");
  });
});

describe("isLocalCompanionBackend", () => {
  it("recognises the local companion origin", () => {
    expect(isLocalCompanionBackend("http://127.0.0.1:8000")).toBe(true);
  });

  it("rejects remote backends", () => {
    expect(isLocalCompanionBackend("https://training.farm:8000")).toBe(false);
    expect(isLocalCompanionBackend("not a url")).toBe(false);
  });

  it("honours an explicit companion origin override", () => {
    expect(isLocalCompanionBackend("https://companion.lan:8443", "https://companion.lan:8443")).toBe(true);
    expect(isLocalCompanionBackend("https://remote.lan:8443", "https://companion.lan:8443")).toBe(false);
  });

  it("matches loopback aliases and trailing slashes", () => {
    expect(isLocalCompanionBackend("http://localhost:8000")).toBe(true);
    expect(isLocalCompanionBackend("http://127.0.0.1:8000/")).toBe(true);
  });
});

describe("companion-origin connection lookup", () => {
  afterEach(() => {
    if ("localStorage" in globalThis) {
      globalThis.localStorage.removeItem("nnm.training.connections");
    }
  });

  it("reuses the saved companion connection regardless of the active remote one", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    saveBackendConnection({
      version: 1,
      baseUrl: "http://127.0.0.1:8000",
      token: "companion-token",
      connectionId: "companion-connection",
      requestId: null,
      verificationCode: null,
      deviceName: null,
    });
    saveBackendConnection({
      version: 1,
      baseUrl: "https://training.example.test",
      token: "remote-training-token",
      connectionId: "remote-connection",
      requestId: null,
      verificationCode: null,
      deviceName: null,
    });

    // The active connection is the remote one, but the origin lookup must
    // return the companion pairing for project calls.
    expect(loadBackendConnection()?.baseUrl).toBe("https://training.example.test");
    const companion = loadBackendConnectionByOrigin("http://127.0.0.1:8000");
    expect(companion?.token).toBe("companion-token");
  });

  it("matches loopback aliases and trailing slashes in saved connections", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    saveBackendConnection({
      version: 1,
      baseUrl: "http://localhost:8000/",
      token: "companion-token",
      connectionId: "companion-connection",
      requestId: null,
      verificationCode: null,
      deviceName: null,
    });

    expect(loadBackendConnectionByOrigin("http://127.0.0.1:8000")?.token).toBe("companion-token");
  });

  it("returns null when no saved connection matches the companion origin", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    saveBackendConnection({
      version: 1,
      baseUrl: "https://training.example.test",
      token: "remote-training-token",
      connectionId: "remote-connection",
      requestId: null,
      verificationCode: null,
      deviceName: null,
    });

    expect(loadBackendConnectionByOrigin("http://127.0.0.1:8000")).toBeNull();
  });
});

describe("ProjectWorkspace restore", () => {
  it("does not send a remote training token to the local companion project API", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    values.set("nnm.training.connections", JSON.stringify({
      version: 1,
      activeUrl: "https://training.example.test",
      connections: {
        "https://training.example.test": {
          version: 1,
          baseUrl: "https://training.example.test",
          token: "remote-training-token",
          connectionId: "remote-connection",
          requestId: null,
          verificationCode: null,
          deviceName: null,
        },
      },
    }));
    const fetchMock = mockFetch({
      "/api/projects": () => errorResponse(401, "missing_token", "local companion rejects remote credentials"),
    });
    const workspace = new ProjectWorkspace();

    await workspace.restore();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("authorization")).not.toBe("Bearer remote-training-token");
  });

  it("shows the chooser when no backend is paired", async () => {
    const workspace = new ProjectWorkspace(() => null);

    await workspace.restore();

    expect(workspace.status).toBe("ready");
    expect(workspace.active).toBeNull();
  });

  it("restores the active project graph and stereotype catalog into the diagram", async () => {
    const diagram = new Diagram();
    const inputStereotype = diagram.getStereotype("Input");
    const builtinCount = diagram.stereotypes.length;
    expect(inputStereotype).toBeDefined();
    const originalNodeCount = diagram.nodes.length;

    const routes: Record<string, (init?: RequestInit) => Response> = {
      "http://companion.test/api/projects": () => jsonResponse({ active: PROJECT, projects: [PROJECT] }),
      "http://companion.test/api/projects/proj-123/graph": () => jsonResponse(DIAGRAM_GRAPH),
      "http://companion.test/api/projects/proj-123/stereotypes": () =>
        jsonResponse({
          stereotypes: [
            { id: "Stereotypes/Modules/Input.json", name: "Input", source: "builtin", data: { category: "Input" } },
            { id: "project-stereotypes/FancyLayer.json", name: "FancyLayer", source: "project", data: { category: "Layer" } },
          ],
          errors: [],
        }),
    };
    mockFetch(routes);
    const workspace = new ProjectWorkspace(() => new ProjectApiClient("http://companion.test/api", "secret-token"));
    workspace.attachDiagram(diagram);

    await workspace.restore();

    expect(workspace.status).toBe("ready");
    expect(workspace.active?.id).toBe("proj-123");
    expect(diagram.nodes.length).toBe(1); // replaced by the project graph
    expect(diagram.getStereotype("FancyLayer")).toBeDefined();
    expect(diagram.getStereotype("Input")).toBeDefined();
    expect(workspace.recent.map((p) => p.id)).toEqual(["proj-123"]);
    void builtinCount;
    void originalNodeCount;
  });

  it("surfaces a connection failure as an actionable error without an active project", async () => {
    mockFetch({
      "http://companion.test/api/projects": () => errorResponse(401, "session_expired", "session expired"),
    });
    const workspace = new ProjectWorkspace(() => new ProjectApiClient("http://companion.test/api", "stale-token"));

    await workspace.restore();

    expect(workspace.status).toBe("error");
    expect(workspace.statusMessage).toContain("session expired");
    expect(workspace.active).toBeNull();
  });
});

describe("ProjectWorkspace applyProject atomicity", () => {
  it("does not replace the diagram or stereotypes when the catalog is invalid", async () => {
    const diagram = new Diagram();
    const originalNodes = [...diagram.nodes];
    const originalStereotypes = diagram.stereotypes;

    mockFetch({
      "http://companion.test/api/projects/proj-123/graph": () => jsonResponse(DIAGRAM_GRAPH),
      "http://companion.test/api/projects/proj-123/stereotypes": () =>
        jsonResponse({
          stereotypes: [
            { id: "project-stereotypes/Broken.json", name: "Broken", source: "project", data: "oops" as unknown as Record<string, unknown> },
          ],
          errors: [],
        }),
    });
    const workspace = new ProjectWorkspace(() => new ProjectApiClient("http://companion.test/api", "secret-token"));

    const result = await workspace.applyProject(PROJECT, diagram);

    expect(result.ok).toBe(false);
    expect(diagram.nodes).toEqual(originalNodes);
    expect(diagram.stereotypes).toEqual(originalStereotypes);
  });

  it("does not replace the diagram or the stereotype catalog when the project graph is not a valid diagram", async () => {
    const diagram = new Diagram();
    const originalNodes = [...diagram.nodes];
    const originalStereotypes = diagram.stereotypes;

    mockFetch({
      "http://companion.test/api/projects/proj-123/graph": () => jsonResponse({ nodes: [], no_edges_here: true }),
      "http://companion.test/api/projects/proj-123/stereotypes": () =>
        jsonResponse({
          stereotypes: [
            { id: "Stereotypes/Modules/Input.json", name: "Input", source: "builtin", data: { category: "Input" } },
            { id: "project-stereotypes/FancyLayer.json", name: "FancyLayer", source: "project", data: { category: "Layer" } },
          ],
          errors: [],
        }),
    });
    const workspace = new ProjectWorkspace(() => new ProjectApiClient("http://companion.test/api", "secret-token"));

    const result = await workspace.applyProject(PROJECT, diagram);

    expect(result.ok).toBe(false);
    expect(diagram.nodes).toEqual(originalNodes);
    expect(diagram.stereotypes).toEqual(originalStereotypes);
    expect(diagram.getStereotype("FancyLayer")).toBeUndefined();
  });

  it("surfaces backend stereotype diagnostics while applying the valid catalog", async () => {
    const diagram = new Diagram();
    mockFetch({
      "http://companion.test/api/projects/proj-123/graph": () => jsonResponse(DIAGRAM_GRAPH),
      "http://companion.test/api/projects/proj-123/stereotypes": () =>
        jsonResponse({
          stereotypes: [
            { id: "Stereotypes/Modules/Input.json", name: "Input", source: "builtin", data: { category: "Input" } },
          ],
          errors: [{ path: "project-stereotypes/Rejected.json", error: "collides with a built-in stereotype" }],
        }),
    });
    const workspace = new ProjectWorkspace(() => new ProjectApiClient("http://companion.test/api", "secret-token"));

    const result = await workspace.applyProject(PROJECT, diagram);

    expect(result.ok).toBe(true);
    expect(workspace.catalogErrors[0].path).toBe("project-stereotypes/Rejected.json");
    expect(diagram.getStereotype("Input")).toBeDefined();
  });
});

describe("ProjectWorkspace create/open/save", () => {
  it("creates a project, applies it, and updates the recent list", async () => {
    const diagram = new Diagram();
    mockFetch({
      "http://companion.test/api/projects": () => jsonResponse(PROJECT, 201),
      "http://companion.test/api/projects/proj-123/graph": () => jsonResponse(DIAGRAM_GRAPH),
      "http://companion.test/api/projects/proj-123/stereotypes": () =>
        jsonResponse({
          stereotypes: [
            { id: "Stereotypes/Modules/Input.json", name: "Input", source: "builtin", data: { category: "Input" } },
          ],
          errors: [],
        }),
    });
    const workspace = new ProjectWorkspace(() => new ProjectApiClient("http://companion.test/api", "secret-token"));
    workspace.attachDiagram(diagram);

    const result = await workspace.createProject("my-model", "/home/me/projects/my-model");

    expect(result.ok).toBe(true);
    expect(workspace.active?.name).toBe("my-model");
    expect(workspace.recent.map((p) => p.id)).toContain("proj-123");
    expect(diagram.nodes.length).toBe(1);
  });

  it("activates a fresh project with no saved graph, keeping the current browser diagram", async () => {
    const diagram = new Diagram();
    const originalNodes = [...diagram.nodes];
    mockFetch({
      "http://companion.test/api/projects": () => jsonResponse(PROJECT, 201),
      "http://companion.test/api/projects/proj-123/graph": () =>
        errorResponse(404, "graph_missing", "graph file model/graph.json is missing from the project"),
      "http://companion.test/api/projects/proj-123/stereotypes": () =>
        jsonResponse({
          stereotypes: [
            { id: "Stereotypes/Modules/Input.json", name: "Input", source: "builtin", data: { category: "Input" } },
            { id: "project-stereotypes/FancyLayer.json", name: "FancyLayer", source: "project", data: { category: "Layer" } },
          ],
          errors: [],
        }),
    });
    const workspace = new ProjectWorkspace(() => new ProjectApiClient("http://companion.test/api", "secret-token"));
    workspace.attachDiagram(diagram);

    const result = await workspace.createProject("my-model", "/home/me/projects/my-model");

    expect(result.ok).toBe(true);
    expect(workspace.active?.id).toBe("proj-123");
    expect(diagram.nodes).toEqual(originalNodes);
    expect(diagram.getStereotype("FancyLayer")).toBeDefined();
  });

  it("opens an existing project by root", async () => {
    const diagram = new Diagram();
    mockFetch({
      "http://companion.test/api/projects/open": () => jsonResponse(PROJECT),
      "http://companion.test/api/projects/proj-123/graph": () => jsonResponse(DIAGRAM_GRAPH),
      "http://companion.test/api/projects/proj-123/stereotypes": () =>
        jsonResponse({
          stereotypes: [
            { id: "Stereotypes/Modules/Input.json", name: "Input", source: "builtin", data: { category: "Input" } },
          ],
          errors: [],
        }),
    });
    const workspace = new ProjectWorkspace(() => new ProjectApiClient("http://companion.test/api", "secret-token"));
    workspace.attachDiagram(diagram);

    const result = await workspace.openProject("/home/me/projects/my-model");

    expect(result.ok).toBe(true);
    expect(workspace.active?.id).toBe("proj-123");
  });

  it("reports create failures as actionable errors without changing the active project", async () => {
    const workspace = new ProjectWorkspace(() => new ProjectApiClient("http://companion.test/api", "secret-token"));
    mockFetch({
      "http://companion.test/api/projects": (init) =>
        init?.method === "POST"
          ? errorResponse(409, "incompatible_root", "root is not empty and does not contain a valid project")
          : jsonResponse({ active: null, projects: [] }),
    });
    await workspace.restore();
    expect(workspace.status).toBe("ready");

    const result = await workspace.createProject("x", "/tmp/non-empty");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("root is not empty");
    expect(workspace.active).toBeNull();
    expect(workspace.status).toBe("ready");
  });

  it("saves the browser diagram to the active project graph", async () => {
    const diagram = new Diagram();
    const fetchMock = mockFetch({
      "http://companion.test/api/projects/proj-123/graph": (init) =>
        init?.method === "PUT" ? jsonResponse(DIAGRAM_GRAPH) : jsonResponse(DIAGRAM_GRAPH),
      "http://companion.test/api/projects/proj-123/stereotypes": () =>
        jsonResponse({
          stereotypes: [
            { id: "Stereotypes/Modules/Input.json", name: "Input", source: "builtin", data: { category: "Input" } },
          ],
          errors: [],
        }),
    });
    const workspace = new ProjectWorkspace(() => new ProjectApiClient("http://companion.test/api", "secret-token"));
    workspace.attachDiagram(diagram);
    const applied = await workspace.applyProject(PROJECT, diagram);
    expect(applied.ok).toBe(true);

    const result = await workspace.saveGraph();

    expect(result.ok).toBe(true);
    expect(workspace.saveSuccess).toBe(true);
    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT") as [string, RequestInit];
    const body = JSON.parse(String(putCall[1].body));
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(Array.isArray(body.edges)).toBe(true);
  });

  it("rejects saving without an active project", async () => {
    const workspace = new ProjectWorkspace(() => new ProjectApiClient("http://companion.test/api", "secret-token"));
    workspace.attachDiagram(new Diagram());

    const result = await workspace.saveGraph();

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/progetto/i);
  });

  it("refuses to save an active project that was never applied (failed restore)", async () => {
    const fetchMock = mockFetch({
      "http://companion.test/api/projects/proj-123/graph": (init) =>
        init?.method === "PUT" ? jsonResponse(DIAGRAM_GRAPH) : jsonResponse(DIAGRAM_GRAPH),
    });
    const workspace = new ProjectWorkspace(() => new ProjectApiClient("http://companion.test/api", "secret-token"));
    workspace.attachDiagram(new Diagram());
    // Failed restore sets the active project for visibility but never the
    // applied id: the browser diagram must not overwrite the project graph.
    workspace.active = PROJECT;

    const result = await workspace.saveGraph();

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/non è stato applicato/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("saves after a successful apply because the applied id matches the active id", async () => {
    const diagram = new Diagram();
    const fetchMock = mockFetch({
      "http://companion.test/api/projects/proj-123/graph": (init) =>
        init?.method === "PUT" ? jsonResponse(DIAGRAM_GRAPH) : jsonResponse(DIAGRAM_GRAPH),
      "http://companion.test/api/projects/proj-123/stereotypes": () =>
        jsonResponse({
          stereotypes: [
            { id: "Stereotypes/Modules/Input.json", name: "Input", source: "builtin", data: { category: "Input" } },
          ],
          errors: [],
        }),
    });
    const workspace = new ProjectWorkspace(() => new ProjectApiClient("http://companion.test/api", "secret-token"));
    workspace.attachDiagram(diagram);
    // Apply sets the applied id; only then may the graph be written.
    const applied = await workspace.applyProject(PROJECT, diagram);
    expect(applied.ok).toBe(true);

    const result = await workspace.saveGraph();

    expect(result.ok).toBe(true);
    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT") as [string, RequestInit];
    expect(putCall).toBeDefined();
  });
});

describe("ProjectWorkspace project datasets", () => {
  it("returns the built-in plus project dataset catalog for the active project", async () => {
    mockFetch({
      "http://companion.test/api/projects/proj-123/datasets": () =>
        jsonResponse({
          datasets: [
            { target: "dataset.mnist.MNISTDataset", name: "MNIST", doc: "", parameters: [], num_classes: 10, source: "builtin" },
            { target: "my_project.MyDataset", name: "MyDataset", doc: "", parameters: [], num_classes: 2, source: "project" },
          ],
          errors: [{ path: "datasets/broken.py", error: "import failed" }],
        }),
    });
    const workspace = new ProjectWorkspace(() => new ProjectApiClient("http://companion.test/api", "secret-token"));
    workspace.active = PROJECT;

    const catalog = await workspace.loadProjectDatasets();

    expect(catalog).not.toBeNull();
    expect(catalog!.datasets.map((dataset) => dataset.target)).toEqual([
      "dataset.mnist.MNISTDataset",
      "my_project.MyDataset",
    ]);
    expect(catalog!.errors[0].path).toBe("datasets/broken.py");
  });

  it("returns null without calling the API when no project is active", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const workspace = new ProjectWorkspace(() => new ProjectApiClient("http://companion.test/api", "secret-token"));

    const catalog = await workspace.loadProjectDatasets();

    expect(catalog).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ProjectWorkspace W&B", () => {
  it("stores the API key without retaining it in state or storage", async () => {
    mockFetch({
      "http://companion.test/api/projects/proj-123/wandb-key": () => jsonResponse({ configured: true }),
    });
    const workspace = new ProjectWorkspace(() => new ProjectApiClient("http://companion.test/api", "secret-token"));
    workspace.active = PROJECT;

    const stored = await workspace.setWandbKey("wandb-super-secret");

    expect(stored).toBe(true);
    expect(workspace.wandbKeyConfigured).toBe(true);
    const state = JSON.stringify(workspace);
    expect(state).not.toContain("wandb-super-secret");
  });

  it("deletes the API key and clears the configured flag", async () => {
    mockFetch({
      "http://companion.test/api/projects/proj-123/wandb-key": () => jsonResponse({ configured: false }),
    });
    const workspace = new ProjectWorkspace(() => new ProjectApiClient("http://companion.test/api", "secret-token"));
    workspace.active = { ...PROJECT, api_key_configured: true };
    workspace.wandbKeyConfigured = true;

    const deleted = await workspace.deleteWandbKey();

    expect(deleted).toBe(true);
    expect(workspace.wandbKeyConfigured).toBe(false);
  });

  it("updates non-secret W&B settings for the active project", async () => {
    mockFetch({
      "http://companion.test/api/projects/proj-123/wandb": (init) =>
        init?.method === "PUT"
          ? jsonResponse({ ...PROJECT.wandb, entity: "team", tags: ["prod"], api_key_configured: false })
          : jsonResponse({ ...PROJECT.wandb, api_key_configured: false }),
    });
    const workspace = new ProjectWorkspace(() => new ProjectApiClient("http://companion.test/api", "secret-token"));
    workspace.active = PROJECT;

    const result = await workspace.updateWandb({ entity: "team", tags: ["prod"] });

    expect(result.ok).toBe(true);
    expect(workspace.active?.wandb.entity).toBe("team");
  });
});

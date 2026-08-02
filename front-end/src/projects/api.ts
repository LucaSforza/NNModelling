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

// front-end/src/projects/api.ts
// Typed client for the companion project workspace APIs. Every project call
// uses the same pairing authentication as the training endpoints.

import { BackendApiError, apiErrorFromResponse, type DatasetInfo } from "../training/api";

export interface EnvironmentState {
  status: "ready" | "missing" | "error";
  python: string;
  message: string;
  synced_at: string | null;
}

export interface WandbSettings {
  entity: string;
  project: string;
  tags: string[];
  run_name_template: string;
  mode: "online" | "offline" | "disabled";
}

export interface ProjectSummary {
  id: string;
  name: string;
  root: string;
  model: string;
  environment: EnvironmentState;
  wandb: WandbSettings;
  api_key_configured: boolean;
  last_opened: string;
  exists: boolean;
  metadata_valid: boolean;
  metadata_error: string | null;
}

export interface RecentProjectsResponse {
  active: ProjectSummary | null;
  projects: ProjectSummary[];
}

export interface StereotypeCatalogEntry {
  id: string;
  name: string;
  source: "builtin" | "project";
  data: Record<string, unknown>;
}

export interface StereotypeCatalogResponse {
  stereotypes: StereotypeCatalogEntry[];
  errors: { path: string; error: string }[];
}

export interface DatasetCatalogResponse {
  datasets: DatasetInfo[];
  errors: { path: string; error: string }[];
}

export interface WandbSettingsResponse extends WandbSettings {
  api_key_configured: boolean;
}

export interface WandbUpdate {
  entity?: string;
  project?: string;
  tags?: string[];
  run_name_template?: string;
  mode?: "online" | "offline" | "disabled";
}

export interface WandbKeyStatus {
  configured: boolean;
}

/**
 * Default companion base for project/workspace calls. In development the Vite
 * server proxies ``/api`` to the local companion; in production the companion
 * serves the built editor on the same origin under the same prefix.
 */
export function projectApiBaseUrl(): string {
  return (import.meta.env.VITE_PROJECT_API_URL as string | undefined) ?? "/api";
}

export class ProjectApiClient {
  readonly baseUrl: string;

  constructor(baseUrl: string = projectApiBaseUrl(), private readonly token: string | null = null) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  createProject(name: string | null, root: string): Promise<ProjectSummary> {
    return this.request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, root }),
    });
  }

  openProject(root: string): Promise<ProjectSummary> {
    return this.request("/projects/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root }),
    });
  }

  listProjects(): Promise<RecentProjectsResponse> {
    return this.request("/projects");
  }

  /** Resolve the active project, treating a missing one as ``null``. */
  async activeProject(): Promise<ProjectSummary | null> {
    try {
      return await this.request<ProjectSummary>("/projects/active");
    } catch (error) {
      if (error instanceof BackendApiError && error.status === 404 && error.code === "no_active_project") {
        return null;
      }
      throw error;
    }
  }

  getProject(projectId: string): Promise<ProjectSummary> {
    return this.request(`/projects/${encodeURIComponent(projectId)}`);
  }

  syncProject(projectId: string): Promise<ProjectSummary> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/sync`, { method: "POST" });
  }

  forgetProject(projectId: string): Promise<ProjectSummary> {
    return this.request(`/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
  }

  readGraph(projectId: string): Promise<Record<string, unknown>> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/graph`);
  }

  writeGraph(projectId: string, graph: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/graph`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(graph),
    });
  }

  projectStereotypes(projectId: string): Promise<StereotypeCatalogResponse> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/stereotypes`);
  }

  projectDatasets(projectId: string): Promise<DatasetCatalogResponse> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/datasets`);
  }

  readWandb(projectId: string): Promise<WandbSettingsResponse> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/wandb`);
  }

  updateWandb(projectId: string, changes: WandbUpdate): Promise<WandbSettingsResponse> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/wandb`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(changes),
    });
  }

  /** Store the W&B API key. The key is write-only: it is never returned. */
  setWandbKey(projectId: string, apiKey: string): Promise<WandbKeyStatus> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/wandb-key`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: apiKey }),
    });
  }

  deleteWandbKey(projectId: string): Promise<WandbKeyStatus> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/wandb-key`, { method: "DELETE" });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    for (const [name, value] of this.authHeaders()) headers.set(name, value);
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (!response.ok) throw await apiErrorFromResponse(response);
    return await response.json() as T;
  }

  /**
   * Build the request Authorization headers. A null token means the request
   * goes out without an Authorization header (anonymous): the companion then
   * rejects it with 401 ``missing_token``, which the workspace surfaces as the
   * actionable unpaired state. Callers must never substitute a token from a
   * different origin here — the project factory only ever passes the
   * companion-origin pairing token.
   */
  private authHeaders(): Headers {
    if (!this.token) return new Headers();
    return new Headers({ authorization: `Bearer ${this.token}` });
  }
}

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

// front-end/src/projects/state.svelte.ts
// Reactive project workspace state. The browser remains the diagram source of
// truth: restore replaces the diagram and stereotype catalog only after both
// the graph and the runtime catalog validate (atomic, no partial apply).

import { StereotypeCore } from "../core/StereotypeCore";
import { compileStereotypeCatalog } from "../core/StereotypeCore";
import type { Diagram } from "../Diagram.svelte";
import { loadBackendConnection, loadBackendConnectionByOrigin, normalizeOriginForComparison } from "../training/connection";
import { BackendApiError } from "../training/api";
import {
  ProjectApiClient,
  projectApiBaseUrl,
  type DatasetCatalogResponse,
  type ProjectSummary,
  type StereotypeCatalogResponse,
  type WandbUpdate,
} from "./api";

export type WorkspaceStatus = "idle" | "restoring" | "ready" | "error";

export interface ProjectApplyResult {
  ok: boolean;
  error?: string;
}

export interface ProjectSaveResult {
  ok: boolean;
  error?: string;
}

type ApiFactory = () => ProjectApiClient | null;

function defaultProjectApiFactory(): ProjectApiClient | null {
  try {
    // Only a saved connection whose origin matches the companion may
    // authenticate project calls. The active connection may belong to a
    // remote training backend, whose token must never reach the companion.
    const companion = loadBackendConnectionByOrigin(companionOrigin());
    if (companion) return new ProjectApiClient(projectApiBaseUrl(), companion.token);
    // No companion pairing: keep a client without a token so restore() still
    // probes the companion and surfaces its 401 missing_token rejection as
    // the actionable unpaired state — never a remote training credential.
    // With no saved connection at all, stay cleanly unpaired (chooser).
    if (!loadBackendConnection()) return null;
    return new ProjectApiClient(projectApiBaseUrl(), null);
  } catch {
    return null;
  }
}

function errorText(error: unknown): string {
  if (error instanceof TypeError) return "Companion irraggiungibile (controlla che il backend locale sia attivo)";
  if (error instanceof BackendApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function isDiagramGraph(graph: Record<string, unknown>): boolean {
  return Array.isArray(graph.nodes) && Array.isArray(graph.edges);
}

/** Normalize an origin for comparison (case, trailing slashes, loopback aliases). */
function normalizeOrigin(origin: string): string {
  return normalizeOriginForComparison(origin);
}

/**
 * Origin of the companion serving the project workspace. In development the
 * Vite proxy forwards ``/api`` to the local companion; in production the
 * companion serves the built editor and the API on the same origin.
 */
export function companionOrigin(): string {
  const env = import.meta.env.VITE_COMPANION_ORIGIN as string | undefined;
  if (env) return env;
  if (import.meta.env.DEV) return "http://127.0.0.1:8000";
  return typeof window !== "undefined" ? window.location.origin : "";
}

/**
 * True when a connected Training backend URL belongs to the local companion.
 * ``project_id`` is sent only in this local context; remote backends receive
 * the unchanged non-project job contract.
 */
export function isLocalCompanionBackend(baseUrl: string, originOverride?: string): boolean {
  let origin: string;
  try {
    origin = normalizeOrigin(new URL(baseUrl).origin);
  } catch {
    return false;
  }
  const expected = normalizeOrigin(originOverride ?? companionOrigin());
  return origin === expected;
}

export class ProjectWorkspace {
  active: ProjectSummary | null = $state.raw(null);
  recent: ProjectSummary[] = $state.raw<ProjectSummary[]>([]);
  status: WorkspaceStatus = $state("idle");
  statusMessage: string | null = $state(null);
  paired = $state(false);
  busy = $state(false);
  error: string | null = $state(null);
  catalogErrors: { path: string; error: string }[] = $state.raw([]);
  saving = $state(false);
  saveSuccess = $state(false);
  saveError: string | null = $state(null);
  wandbKeyConfigured = $state(false);
  wandbKeyBusy = $state(false);
  wandbKeyError: string | null = $state(null);

  private api: ProjectApiClient | null = null;
  private diagram: Diagram | null = null;
  private appliedProjectId: string | null = null;

  constructor(private readonly apiFactory: ApiFactory = defaultProjectApiFactory) {}

  /** Attach the editor diagram so project apply/save can act on it. */
  attachDiagram(diagram: Diagram): void {
    this.diagram = diagram;
  }

  get hasActiveProject(): boolean {
    return this.active !== null;
  }

  /**
   * Startup restore: load the recent registry and the recorded active project,
   * applying its graph and stereotype catalog when both validate.
   */
  async restore(): Promise<void> {
    this.status = "restoring";
    this.statusMessage = null;
    this.error = null;
    const api = this.apiFactory();
    if (!api) {
      this.paired = false;
      this.api = null;
      this.status = "ready";
      return;
    }
    this.api = api;
    this.paired = true;
    try {
      const list = await api.listProjects();
      this.recent = list.projects;
      const active = list.active;
      if (active && this.diagram) {
        const result = await this.applyProject(active, this.diagram);
        if (!result.ok) {
          // The active project exists but could not be applied atomically:
          // surface the diagnostic while keeping the previous diagram intact.
          this.active = active;
          this.wandbKeyConfigured = active.api_key_configured;
          this.status = "error";
          this.statusMessage = result.error ?? "Impossibile ripristinare il progetto attivo";
          return;
        }
      } else {
        this.active = active;
        if (active) this.wandbKeyConfigured = active.api_key_configured;
      }
      this.status = "ready";
    } catch (error) {
      this.status = "error";
      this.statusMessage = errorText(error);
      this.active = null;
      this.recent = [];
    }
  }

  /** Re-apply the current active project (used to retry after failures). */
  async retryApply(): Promise<ProjectApplyResult> {
    if (!this.active) return { ok: false, error: "Nessun progetto attivo" };
    const result = await this.applyProject(this.active, this.diagram);
    if (result.ok) {
      this.status = "ready";
      this.statusMessage = null;
    }
    return result;
  }

  /** Create a new project at ``root`` and apply it as the active project. */
  async createProject(name: string | null, root: string): Promise<ProjectApplyResult> {
    return this.withOperation(async () => {
      const api = this.requireApi();
      const created = await api.createProject(name, root);
      this.bumpRecent(created);
      return this.applyProject(created, this.diagram);
    });
  }

  /** Open an existing project by root path and apply it. */
  async openProject(root: string): Promise<ProjectApplyResult> {
    return this.withOperation(async () => {
      const api = this.requireApi();
      const opened = await api.openProject(root);
      this.bumpRecent(opened);
      return this.applyProject(opened, this.diagram);
    });
  }

  /** Open a recent project, re-registering it so ordering stays current. */
  async openRecent(project: ProjectSummary): Promise<ProjectApplyResult> {
    return this.openProject(project.root);
  }

  /** Persist the browser diagram into the active project graph. */
  async saveGraph(): Promise<ProjectSaveResult> {
    const project = this.active;
    const diagram = this.diagram;
    if (!project) return { ok: false, error: "Nessun progetto attivo: crea o apri un progetto prima di salvare" };
    if (!diagram) return { ok: false, error: "Editor non pronto" };
    // Safety: only the applied project may be saved. A failed restore sets the
    // active project for visibility but never the applied id, so an unapplied
    // browser diagram cannot overwrite the project graph.
    if (this.appliedProjectId !== project.id) {
      return {
        ok: false,
        error: "Il progetto attivo non è stato applicato correttamente: riprova l'apertura prima di salvare",
      };
    }
    const api = this.requireApi();
    this.saving = true;
    this.saveError = null;
    this.saveSuccess = false;
    try {
      const graph = JSON.parse(diagram.exportToJson()) as Record<string, unknown>;
      await api.writeGraph(project.id, graph);
      this.saveSuccess = true;
      return { ok: true };
    } catch (error) {
      this.saveError = errorText(error);
      return { ok: false, error: this.saveError };
    } finally {
      this.saving = false;
    }
  }

  /** Re-run the companion-driven environment synchronization. */
  async syncActive(): Promise<ProjectApplyResult> {
    return this.withOperation(async () => {
      const project = this.active;
      if (!project) return { ok: false, error: "Nessun progetto attivo" };
      const fresh = await this.requireApi().syncProject(project.id);
      this.active = fresh;
      this.wandbKeyConfigured = fresh.api_key_configured;
      this.updateRecent(fresh);
      this.statusMessage = null;
      return { ok: true };
    });
  }

  /** Persist non-secret W&B settings for the active project. */
  async updateWandb(changes: WandbUpdate): Promise<ProjectApplyResult> {
    return this.withOperation(async () => {
      const project = this.active;
      if (!project) return { ok: false, error: "Nessun progetto attivo" };
      const response = await this.requireApi().updateWandb(project.id, changes);
      const updated = { ...project, wandb: response };
      this.active = updated;
      this.wandbKeyConfigured = response.api_key_configured;
      this.updateRecent(updated);
      return { ok: true };
    });
  }

  /** Store the W&B API key write-only; the key never enters workspace state. */
  async setWandbKey(apiKey: string): Promise<boolean> {
    const project = this.active;
    if (!project) return false;
    this.wandbKeyBusy = true;
    this.wandbKeyError = null;
    try {
      await this.requireApi().setWandbKey(project.id, apiKey);
      this.wandbKeyConfigured = true;
      return true;
    } catch (error) {
      this.wandbKeyError = errorText(error);
      return false;
    } finally {
      this.wandbKeyBusy = false;
    }
  }

  /** Remove the stored W&B API key. */
  async deleteWandbKey(): Promise<boolean> {
    const project = this.active;
    if (!project) return false;
    this.wandbKeyBusy = true;
    this.wandbKeyError = null;
    try {
      await this.requireApi().deleteWandbKey(project.id);
      this.wandbKeyConfigured = false;
      return true;
    } catch (error) {
      this.wandbKeyError = errorText(error);
      return false;
    } finally {
      this.wandbKeyBusy = false;
    }
  }

  /**
   * Close the active project: keep the current browser diagram but restore
   * the built-in stereotype catalog so project stereotypes do not linger.
   */
  closeProject(): void {
    this.active = null;
    this.catalogErrors = [];
    this.wandbKeyConfigured = false;
    this.saveError = null;
    this.saveSuccess = false;
    this.appliedProjectId = null;
    this.diagram?.setStereotypes(StereotypeCore.loadFromDirectory());
  }

  /**
   * Apply a project's graph and stereotype catalog atomically: neither the
   * diagram nor the catalog is replaced unless both validate.
   */
  async applyProject(project: ProjectSummary, diagram: Diagram | null): Promise<ProjectApplyResult> {
    if (!diagram) return { ok: false, error: "Editor non pronto" };
    const api = this.requireApi();
    let graph: Record<string, unknown> | null = null;
    let catalog: StereotypeCatalogResponse;
    try {
      // A fresh project has no saved graph yet: keep the current browser
      // diagram (explicit save persists it). A graph that exists must parse.
      [graph, catalog] = await Promise.all([
        api.readGraph(project.id).catch((error: unknown) => {
          if (error instanceof BackendApiError && error.code === "graph_missing") return null;
          throw error;
        }),
        api.projectStereotypes(project.id),
      ]);
    } catch (error) {
      return { ok: false, error: `Impossibile caricare il progetto: ${errorText(error)}` };
    }

    // 1. Catalog validation first: malformed/colliding entries reject the
    //    whole catalog (atomic) so no partial replacement can occur.
    const compiled = compileStereotypeCatalog(catalog.stereotypes);
    this.catalogErrors = compiled.stereotypes ? catalog.errors : [...catalog.errors, ...compiled.errors];
    if (!compiled.stereotypes) {
      return {
        ok: false,
        error: "Il catalogo stereotipi del progetto non è valido; nessuna modifica applicata",
      };
    }

    // 2. Graph validation before touching the editor (when one exists).
    if (graph !== null && !isDiagramGraph(graph)) {
      return { ok: false, error: "Il grafico del progetto non è un diagramma valido (mancano nodes o edges)" };
    }

    // 3. Atomic apply: replace the diagram first (when a saved graph exists),
    //    then the stereotype catalog only after the graph import succeeded.
    //    A missing graph (fresh project) keeps the canvas; a failed import
    //    leaves both the diagram and the catalog untouched.
    if (graph !== null) {
      const imported = diagram.importFromJson(JSON.stringify(graph));
      if (!imported) {
        return { ok: false, error: "Il grafico del progetto non è un diagramma valido" };
      }
    }
    diagram.setStereotypes(compiled.stereotypes);

    this.active = project;
    this.wandbKeyConfigured = project.api_key_configured;
    this.appliedProjectId = project.id;
    this.error = null;
    this.status = "ready";
    return { ok: true };
  }

  /**
   * Fetch the runtime dataset catalog (installed plus validated project
   * classes) for the active project. Returns ``null`` when no project is
   * active or the catalog cannot be loaded; the workspace error is set so
   * the sidebar can surface it.
   */
  async loadProjectDatasets(): Promise<DatasetCatalogResponse | null> {
    const project = this.active;
    if (!project) return null;
    try {
      return await this.requireApi().projectDatasets(project.id);
    } catch (error) {
      this.error = errorText(error);
      return null;
    }
  }

  private async withOperation<T extends ProjectApplyResult>(operation: () => Promise<T>): Promise<T> {
    this.busy = true;
    this.error = null;
    try {
      const result = await operation();
      if (!result.ok) this.error = result.error ?? "Operazione non riuscita";
      return result;
    } catch (error) {
      const message = errorText(error);
      this.error = message;
      return { ok: false, error: message } as T;
    } finally {
      this.busy = false;
    }
  }

  private bumpRecent(project: ProjectSummary): void {
    this.recent = [project, ...this.recent.filter((p) => p.id !== project.id)];
  }

  private updateRecent(project: ProjectSummary): void {
    this.recent = this.recent.map((p) => (p.id === project.id ? project : p));
  }

  private requireApi(): ProjectApiClient {
    if (!this.api) {
      const created = this.apiFactory();
      if (!created) throw new BackendApiError(401, "missing_token", "Backend non associato: collega il backend dal pannello Training");
      this.api = created;
      this.paired = true;
    }
    return this.api;
  }
}

/** Application singleton; components read it via Svelte reactivity. */
export const projectState = new ProjectWorkspace();

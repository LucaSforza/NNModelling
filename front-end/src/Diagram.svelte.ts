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

// front-end/src/Diagram.svelte.ts
// Thin Svelte wrapper around DiagramCore.
// Adds $state.raw reactivity for Svelte 5.

import { type Node, type Edge } from "@xyflow/svelte";
import { DiagramCore } from "./core/DiagramCore";
import type { LayoutDirection } from "./layout/autoLayout";
import type { GraphInferenceResult } from "./type-system/graph/types";
import { EditorTypeSystemRuntime } from "./type-system/editor-runtime";
import type { ModelBundleResources, PackageCatalogMetadata, PreparedModelScope } from "./type-system/editor-runtime";
import type { PackageExportInfo } from "./type-system/packages/types";
import type { PackageIdentity } from "./core/types";
import type { DiagramCoreSnapshot } from "./core/types";
import {
  PackageRuntimeDiagnosticCollection,
  packageDiagnosticIdentity,
  type PackageRuntimeDiagnostic,
} from "./type-system/diagnostics";

export const DIAGRAM_CONTEXT_KEY = Symbol("diagram-context");

export class Diagram extends DiagramCore {
  public nodes: Node[] = $state.raw<Node[]>([]);
  public edges: Edge[] = $state.raw<Edge[]>([]);
  private reactiveLayoutDirection: LayoutDirection = $state("vertical");
  /** Sole editor inference result; it is always package-engine data. */
  public typeResult: GraphInferenceResult | null = $state.raw(null);
  public packageCatalog: PackageCatalogMetadata[] = $state.raw([]);
  /** Reactive readiness and fatal diagnostics for the browser-owned runtime. */
  public packageRuntimeReady = $state(false);
  public packageRuntimeDiagnostics: PackageRuntimeDiagnostic[] = $state.raw([]);
  private packageTypeRuntime: EditorTypeSystemRuntime | null = null;
  private readonly packageRuntimeReadyPromise: Promise<void>;
  private readonly diagnosticCollection = new PackageRuntimeDiagnosticCollection();

  public get runtimeReady(): boolean { return this.packageRuntimeReady; }

  public override get layoutDirection(): LayoutDirection {
    return this.reactiveLayoutDirection;
  }

  public override set layoutDirection(value: LayoutDirection) {
    this.reactiveLayoutDirection = value;
  }

  constructor() {
    super();
    // Clear the undo snapshot captured during auto-spawn of Input node —
    // the initial Input should not be undoable.
    this._undoStack = [];
    this._redoStack = [];

    // Force Svelte 5 reactivity when the Core state is mutated via RPC.
    // The subscription is synchronous: typeResult is refreshed before the
    // RPC handler returns.
    this.onGraphChanged(() => {
      this.nodes = [...this.nodes];
      this.edges = [...this.edges];
      if (this.packageTypeRuntime) this.refreshTypes();
    });

    this.refreshTypes();
    this.packageRuntimeReadyPromise = this.initializePackageTypes();
  }

  /** Recompute tensor annotations and diagnostics for the current graph. */
  public refreshTypes(): GraphInferenceResult {
    if (!this.packageTypeRuntime) {
      const result: GraphInferenceResult = {
        nodes: new Map(), order: [], terminals: [], complete: false,
      };
      this.typeResult = result;
      this.publishDiagnostics();
      return result;
    }
    const result = this.packageTypeRuntime.infer({ nodes: this.nodes, edges: this.edges });
    this.typeResult = result;
    this.syncRuntimeDiagnostics();
    const liveFaultOccurrences = new Set<string>();
    for (const [nodeId, state] of result.nodes) {
      if (state.status !== "fault") continue;
      const identity = this.nodes.find((node) => node.id === nodeId)?.data?.package as { id?: unknown; version?: unknown } | undefined;
      const packageId = typeof identity?.id === "string" ? identity.id : state.fault.packageId;
      const packageVersion = typeof identity?.version === "string" ? identity.version : undefined;
      const occurrenceId = `${state.fault.phase}:${packageId}@${packageVersion ?? "?"}:${nodeId}`;
      liveFaultOccurrences.add(occurrenceId);
      this.diagnosticCollection.record({
        occurrenceId,
        phase: state.fault.phase,
        packageId,
        packageVersion,
        nodeId,
        message: state.fault.message,
      });
    }
    this.diagnosticCollection.resolveWhere((diagnostic) => (
      diagnostic.nodeId !== undefined && !liveFaultOccurrences.has(diagnostic.occurrenceId)
    ));
    this.publishDiagnostics();
    return result;
  }

  /** Presentation docking is intentionally limited to ordinary layer nodes. */
  public isLayerNode(node: Node): boolean {
    const identity = node.data?.package as { id?: unknown; version?: unknown } | undefined;
    if (typeof identity?.id !== "string" || typeof identity.version !== "string") return false;
    return this.packageCatalog.some((metadata) => (
      metadata.id === identity.id &&
      metadata.version === identity.version &&
      metadata.definition.kind === "layer"
    ));
  }

  private async initializePackageTypes(): Promise<void> {
    try {
      this.packageTypeRuntime = await EditorTypeSystemRuntime.create();
      this.syncPackageCatalog();
      this.packageRuntimeReady = this.packageTypeRuntime.isReady();
      this.syncRuntimeDiagnostics();
      if (!this.packageRuntimeReady) {
        const failedCore = this.packageTypeRuntime.activationStates()
          .filter((status) => status.source === "bundled" && status.state === "failed")
          .map((status) => `${status.key}: ${status.error ?? "activation failed"}`);
        this.diagnosticCollection.record({
          occurrenceId: "runtime:core-bootstrap",
          phase: "activation",
          message: failedCore.length > 0
            ? `core package bootstrap failed: ${failedCore.join("; ")}`
            : "core package bootstrap is incomplete",
        });
      } else {
        this.diagnosticCollection.resolve("runtime:core-bootstrap");
      }
      if (this.nodes.length === 0 && this.packageTypeRuntime.isReady()) {
        const input = this.packageCatalog.find((metadata) => metadata.definition.kind === "input");
        if (input) {
          const centerX = (typeof window !== "undefined" ? window.innerWidth : 1024) / 2 - 15;
          this.addPackageNode(
            { id: input.id, version: input.version, name: input.definition.name },
            input.definition.kind,
            centerX,
            50,
            { params: Object.fromEntries(Object.entries(input.definition.parameters).flatMap(([key, definition]) =>
              definition.default === undefined ? [] : [[key, structuredClone(definition.default)]])) },
          );
          this._undoStack = [];
          this._redoStack = [];
        }
      }
      this.refreshTypes();
    } catch (error) {
      this.diagnosticCollection.record({
        occurrenceId: "runtime:bootstrap",
        phase: "discovery",
        message: error instanceof Error ? error.message : String(error),
      });
      this.packageRuntimeReady = false;
      this.publishDiagnostics();
    }
  }

  /** Wait for bootstrap before package-aware project operations. */
  public waitForPackageRuntime(): Promise<void> { return this.packageRuntimeReadyPromise; }

  /** Activate one exact package identity before a package node is created. */
  public async activatePackage(identity: PackageIdentity): Promise<void> {
    await this.packageRuntimeReadyPromise;
    if (!this.packageTypeRuntime) throw new Error("package type-system is unavailable");
    const status = await this.packageTypeRuntime.activate(identity);
    if (status.state === "failed") {
      this.syncRuntimeDiagnostics();
      throw new Error(status.error ?? `package '${identity.id}@${identity.version}' activation failed`);
    }
    this.syncPackageCatalog();
    this.syncRuntimeDiagnostics();
    this.refreshTypes();
  }

  /** Node creation seam used by package-manager/sidebar integrations. */
  public async addActivatedPackageNode(
    identity: PackageIdentity,
    kind: Parameters<DiagramCore["addPackageNode"]>[1],
    x: number,
    y: number,
    config?: Parameters<DiagramCore["addPackageNode"]>[4],
  ) {
    await this.activatePackage(identity);
    return this.addPackageNode(identity, kind, x, y, config);
  }

  public get packageActivationStates() {
    return this.packageTypeRuntime?.activationStates() ?? [];
  }

  /** Read-only package resource seam for the backend bundle exporter. */
  public packageExports(): ReadonlyMap<string, PackageExportInfo> {
    if (!this.packageTypeRuntime) throw new Error("package type-system is unavailable");
    return this.packageTypeRuntime.packageExports();
  }

  /** Prepare a package scope without mutating the graph or active runtime. */
  public async prepareProjectScope(
    modelJson: string,
    modelBundle: ModelBundleResources,
  ): Promise<{ readonly snapshot: DiagramCoreSnapshot; readonly scope: PreparedModelScope }> {
    const snapshot = this.parseProjectJson(modelJson);
    if (!snapshot) throw new Error("project JSON is invalid");
    await this.packageRuntimeReadyPromise;
    if (!this.packageTypeRuntime) throw new Error("package type-system is unavailable");
    const graphIdentities = snapshot.nodes.flatMap((node) => {
      const identity = node.data?.package as { id?: unknown; version?: unknown; name?: unknown } | undefined;
      return typeof identity?.id === "string" && typeof identity.version === "string"
        ? [{ id: identity.id, version: identity.version, ...(typeof identity.name === "string" ? { name: identity.name } : {}) }]
        : [];
    });
    const scope = await this.packageTypeRuntime.prepareModelScope(snapshot.manifest, modelBundle, graphIdentities);
    return { snapshot, scope };
  }

  /** Commit one already-prepared scope through DiagramCore and refresh UI state. */
  public async commitPreparedProjectScope(prepared: { readonly snapshot: DiagramCoreSnapshot; readonly scope: PreparedModelScope }): Promise<void> {
    await this.packageRuntimeReadyPromise;
    if (!this.packageTypeRuntime) throw new Error("package type-system is unavailable");
    this.commitProject(prepared.snapshot);
    await this.packageTypeRuntime.commitModelScope(prepared.scope);
    this.diagnosticCollection.clear();
    this.syncPackageCatalog();
    this.syncRuntimeDiagnostics();
    this.refreshTypes();
  }

  /** Restore a previously committed project after a failed authoring commit. */
  public async restoreProjectScope(modelJson: string, modelBundle: ModelBundleResources): Promise<void> {
    const prepared = await this.prepareProjectScope(modelJson, modelBundle);
    await this.commitPreparedProjectScope(prepared);
  }

  private syncPackageCatalog(): void {
    if (this.packageTypeRuntime) this.packageCatalog = this.packageTypeRuntime.availablePackages();
  }

  /** Reconcile exact package references before the single graph commit. */
  public async importProjectJson(jsonString: string, modelBundle?: ModelBundleResources): Promise<boolean> {
    const parsed = this.parseProjectJson(jsonString);
    if (!parsed) return false;
    await this.packageRuntimeReadyPromise;
    if (this.packageTypeRuntime) {
      let prepared;
      try {
        const graphIdentities = parsed.nodes.flatMap((node) => {
          const identity = node.data?.package as { id?: unknown; version?: unknown; name?: unknown } | undefined;
          return typeof identity?.id === "string" && typeof identity.version === "string"
            ? [{ id: identity.id, version: identity.version, ...(typeof identity.name === "string" ? { name: identity.name } : {}) }]
            : [];
        });
        prepared = await this.packageTypeRuntime.prepareModelScope(parsed.manifest, modelBundle, graphIdentities);
      } catch (error) {
        this.diagnosticCollection.record({
          occurrenceId: `runtime:model-switch:${parsed.manifest.id}@${parsed.manifest.version}`,
          phase: "activation",
          message: error instanceof Error ? error.message : String(error),
        });
        this.publishDiagnostics();
        return false;
      }
      // DiagramCore remains the graph authority: prepare all package runtime
      // resources first, then commit the parsed graph and finally swap scopes.
      this.commitProject(parsed);
      await this.packageTypeRuntime.commitModelScope(prepared);
      this.diagnosticCollection.clear();
      this.syncPackageCatalog();
      this.syncRuntimeDiagnostics();
      this.refreshTypes();
      return true;
    }
    this.commitProject(parsed);
    this.refreshTypes();
    return true;
  }

  private syncRuntimeDiagnostics(): void {
    const runtime = this.packageTypeRuntime;
    if (!runtime) return;
    for (const diagnostic of runtime.diagnostics()) {
      const identity = packageDiagnosticIdentity(diagnostic.key);
      const phase = diagnostic.phase === "conflict" ? "dependency" : diagnostic.phase === "removal" ? "disposal" : diagnostic.phase;
      this.diagnosticCollection.record({
        occurrenceId: `runtime:${diagnostic.key}:${diagnostic.phase}`,
        phase,
        ...identity,
        message: diagnostic.message,
      });
    }
  }

  private publishDiagnostics(): void {
    this.packageRuntimeDiagnostics = [...this.diagnosticCollection.snapshot()];
  }
}

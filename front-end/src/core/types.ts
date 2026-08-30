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

// Re-export Svelte Flow types (type-only — no runtime dependency)
import type { Node, Edge } from "@xyflow/svelte";
import type { LayoutDirection } from "../layout/autoLayout";
import { isVersion } from "../type-system/packages/semver";
export type { Node, Edge };
export type { LayoutDirection };

// ── Position ────────────────────────────────────
export interface Position { x: number; y: number; }

/** A finite bend position stored in an edge's immediate containment scope. */
export interface EdgeRoutePoint {
  x: number;
  y: number;
}

/** Persisted route metadata carried by editable Svelte Flow edges. */
export interface EdgeRouteData {
  route: {
    points: EdgeRoutePoint[];
  };
}

// ── Node Configuration ──────────────────────────
export interface NodeConfig {
  name?: string;
  color?: string;
  width?: number;
  height?: number;
  params?: Record<string, unknown>;
  /** Stable named batch slot for a top-level Input node. */
  inputBinding?: string;
}

/** Runtime identity carried by editor nodes.
 *
 * `name` is retained in memory for existing editor callers, but it is not a
 * persisted identity (DiagramCore strips it at the project boundary).
 */
export interface PackageIdentity {
  id: string;
  version: string;
  name: string;
}

/** Canonical project identity. Display metadata is deliberately absent. */
export interface PersistedPackageIdentity {
  id: string;
  version: string;
}

/** A model-owned package directory and its exact package identity. */
export interface ModelPackageReference {
  readonly id: string;
  readonly version: string;
  readonly path: string;
}

/** Source metadata persisted alongside a package-native model graph. */
export interface ModelManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description?: string;
  readonly customPackages: readonly ModelPackageReference[];
}

const MODEL_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

/**
 * Parse the model-level manifest without retaining references to input data.
 * Package manifests are intentionally validated by the package runtime; this
 * validator only owns the model source metadata and its relative paths.
 */
export function parseModelManifest(value: unknown): ModelManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("model manifest must be an object");
  }
  const object = value as Record<string, unknown>;
  assertKnownKeys(object, ["schemaVersion", "id", "version", "name", "description", "customPackages"], "model manifest");
  if (object.schemaVersion !== 1) throw new Error("model manifest schemaVersion must be 1");

  const id = nonEmptyString(object.id, "model manifest id");
  if (!MODEL_ID.test(id)) throw new Error("model manifest id is invalid");
  const version = nonEmptyString(object.version, "model manifest version");
  if (!isVersion(version)) throw new Error("model manifest version is invalid");
  const name = nonEmptyString(object.name, "model manifest name");
  const description = object.description === undefined
    ? undefined
    : nonEmptyString(object.description, "model manifest description");
  if (!Array.isArray(object.customPackages)) {
    throw new Error("model manifest customPackages must be an array");
  }

  const identities = new Set<string>();
  const paths = new Set<string>();
  const customPackages = object.customPackages.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`model manifest customPackages[${index}] must be an object`);
    }
    const packageObject = candidate as Record<string, unknown>;
    assertKnownKeys(packageObject, ["id", "version", "path"], `model manifest customPackages[${index}]`);
    const packageId = nonEmptyString(packageObject.id, `model manifest customPackages[${index}].id`);
    if (!MODEL_ID.test(packageId)) throw new Error(`model manifest customPackages[${index}].id is invalid`);
    const packageVersion = nonEmptyString(packageObject.version, `model manifest customPackages[${index}].version`);
    if (!isVersion(packageVersion)) throw new Error(`model manifest customPackages[${index}].version is invalid`);
    const packagePath = relativeModelPath(packageObject.path, `model manifest customPackages[${index}].path`);
    const identity = `${packageId}@${packageVersion}`;
    if (identities.has(identity)) throw new Error(`model manifest customPackages contains duplicate package '${identity}'`);
    if (paths.has(packagePath)) throw new Error(`model manifest customPackages contains duplicate path '${packagePath}'`);
    identities.add(identity);
    paths.add(packagePath);
    return { id: packageId, version: packageVersion, path: packagePath };
  });

  return {
    schemaVersion: 1,
    id,
    version,
    name,
    ...(description === undefined ? {} : { description }),
    customPackages,
  };
}

/** Alias for callers that use validator terminology. */
export const validateModelManifest = parseModelManifest;

function assertKnownKeys(object: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extra = Object.keys(object).find((key) => !allowed.includes(key));
  if (extra) throw new Error(`${label} has unknown field '${extra}'`);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function relativeModelPath(value: unknown, label: string): string {
  const path = nonEmptyString(value, label).replaceAll("\\", "/");
  const segments = path.split("/");
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path.includes("\0") || segments.some((segment) => segment === ".." || segment === "." || segment === "")) {
    throw new Error(`${label} must be a relative path inside the model bundle`);
  }
  return path;
}

export interface JoinNodeConfig extends NodeConfig {
  inputsCount?: number;
}

// ── Snapshots ───────────────────────────────────
export interface DiagramCoreSnapshot {
  nodes: Node[];
  edges: Edge[];
  layoutDirection: LayoutDirection;
  manifest: ModelManifest;
}

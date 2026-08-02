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

// front-end/src/core/StereotypeCore.ts

import type { TypeSignature, ShapeDimPattern, ShapePattern } from "../conversion/tensortypes";

export interface ModuleParameter {
  type: string;
  default: string;
  position?: "top" | "bottom";
}

export interface StereotypeView {
  color: string;
  width: number;
  height: number;
}

export interface StereotypeJson {
  category?: string;
  pythonClassName?: string;
  taskType?: "classification" | "regression";
  view?: Partial<StereotypeView>;
  params?: Record<string, ModuleParameter>;
  type_signature?: TypeSignature;
}

export class StereotypeCore {
  public readonly id: string;
  public readonly name: string;
  public readonly category: string;
  public readonly pythonClassName: string;
  public readonly taskType: string;
  public readonly parameters: Record<string, ModuleParameter>;
  public readonly view: StereotypeView;
  public readonly typeSignature?: TypeSignature;
  public readonly isJoin: boolean;
  public readonly isInput: boolean;
  public readonly isLoss: boolean;
  public readonly isSubFlow: boolean;

  constructor(filePath: string, data: StereotypeJson) {
    this.id = filePath;

    // Extract name from filename
    const parts = filePath.split("/");
    const nameWithExt = parts[parts.length - 1] || filePath;
    const dotIndex = nameWithExt.lastIndexOf(".");
    this.name = dotIndex > 0 ? nameWithExt.substring(0, dotIndex) : nameWithExt;

    this.category = data.category || "Uncategorized";
    this.pythonClassName = data.pythonClassName || "";
    this.taskType = data.taskType || "";

    this.parameters = {};
    if (data.params) {
      for (const [key, param] of Object.entries(data.params)) {
        this.parameters[key] = {
          type: param.type || "string",
          default: param.default || "",
          position: param.position,
        };
      }
    }

    const view = data.view || {};
    this.view = {
      color: view.color || "#4779c4",
      width: view.width || 140,
      height: view.height || 60,
    };

    this.typeSignature = StereotypeCore.parseTypeSignature(data.type_signature);

    // Category flags
    this.isJoin   = data.category === "Join"   || filePath.includes("/Joins/");
    this.isInput  = data.category === "Input";
    this.isLoss   = data.category === "Loss";
    this.isSubFlow = data.category === "Subflow" || filePath.includes("/SubFlows/");
  }

  // ── Vite loader (browser) ─────────────────────
  // Uses import.meta.glob — a Vite compile-time feature.
  // This method is only callable in the browser/Vite context.
  public static loadFromDirectory(): StereotypeCore[] {
    const files = import.meta.glob('../../../Stereotypes/**/*.json', { eager: true }) as Record<string, any>;
    const loaded: StereotypeCore[] = [];

    for (const [path, rawData] of Object.entries(files)) {
      const jsonData = rawData.default || rawData;
      try {
        loaded.push(new StereotypeCore(path, jsonData));
      } catch (e) {
        console.error(`Error loading stereotype from ${path}:`, e);
      }
    }

    return loaded.sort((a, b) => a.name.localeCompare(b.name));
  }

  // ── Runtime catalog compilation ──────────────────────────────────

  /**
   * Wire form of one catalog entry served by the companion: catalog-relative
   * path plus the complete JSON definition. Built-ins keep the
   * ``Stereotypes/...`` layout so path conventions survive runtime loading.
   */
  public static compileCatalog(
    entries: StereotypeCatalogEntryWire[],
  ): StereotypeCatalogCompileResult {
    const errors: { path: string; error: string }[] = [];
    const compiled: StereotypeCore[] = [];
    const seenNames = new Set<string>();

    for (const entry of entries) {
      if (entry.data === null || typeof entry.data !== "object" || Array.isArray(entry.data)) {
        errors.push({ path: entry.id, error: "malformed stereotype definition (expected a JSON object)" });
        continue;
      }
      let stereotype: StereotypeCore;
      try {
        stereotype = new StereotypeCore(entry.id, entry.data as unknown as StereotypeJson);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ path: entry.id, error: `cannot load stereotype: ${message}` });
        continue;
      }
      if (seenNames.has(stereotype.name)) {
        errors.push({
          path: entry.id,
          error: `duplicate stereotype name ${stereotype.name!} was rejected`,
        });
        continue;
      }
      seenNames.add(stereotype.name);
      compiled.push(stereotype);
    }

    // Atomicity contract: a malformed definition or a name collision rejects
    // the whole catalog (null) so callers never apply a partial replacement.
    if (errors.length > 0) return { stereotypes: null, errors };
    compiled.sort((a, b) => a.name.localeCompare(b.name));
    return { stereotypes: compiled, errors };
  }

  // ── Type signature parsing ────────────────────────

  /**
   * Deep-clone and strip $ from symbolic names in the type signature.
   * $B → { kind: 'symbolic', name: 'B' }
   */
  private static parseTypeSignature(raw: TypeSignature | undefined): TypeSignature | undefined {
    if (!raw) return undefined;
    // Distinguish join input (ShapePattern[]) from module input (ShapePattern):
    // join input's first element is itself an array.
    const joined = Array.isArray(raw.input[0]);
    return {
      kind: raw.kind,
      input: joined
        ? (raw.input as ShapePattern[]).map((pat) => pat.map((d) => StereotypeCore.stripDollar(d)))
        : (raw.input as ShapePattern).map((d) => StereotypeCore.stripDollar(d)),
      output: raw.output.map((d) => StereotypeCore.stripDollar(d)),
      dtype: raw.dtype ? { ...raw.dtype } : undefined,
      subflow: raw.subflow ? { ...raw.subflow } : undefined,
      join: raw.join ? { ...raw.join } : undefined,
      advisories: raw.advisories ? [...raw.advisories] : undefined,
    };
  }

  private static stripDollar(dim: ShapeDimPattern): ShapeDimPattern {
    if (dim.kind === "symbolic" && dim.name.startsWith("$")) {
      return { ...dim, name: dim.name.slice(1) };
    }
    // Computed dims carry an expression string; the `$` inside it is not a
    // symbolic name but tokenizer syntax ($H, $*, ...) and is left untouched.
    return dim;
  }
}

/**
 * Wire form of one catalog entry served by the companion: catalog-relative
 * path plus the complete JSON definition. Built-ins keep the
 * ``Stereotypes/...`` layout so path conventions survive runtime loading.
 */
export interface StereotypeCatalogEntryWire {
  id: string;
  name: string;
  source: "builtin" | "project";
  data: Record<string, unknown>;
}

export interface StereotypeCatalogCompileResult {
  /**
   * Compiled stereotypes, or ``null`` when any entry is malformed or a name
   * collides — callers must then keep their previous catalog intact (atomic,
   * no partial replacement).
   */
  stereotypes: StereotypeCore[] | null;
  errors: { path: string; error: string }[];
}

/**
 * Compile the companion's runtime catalog (built-ins plus validated project
 * stereotypes) into {@link StereotypeCore} instances.
 *
 * Atomicity contract: a malformed definition or a name collision rejects the
 * whole catalog with actionable diagnostics instead of applying a partial
 * replacement. Collisions with built-in names are rejected explicitly so
 * opening a project can never silently change the meaning of a built-in layer.
 */
export function compileStereotypeCatalog(
  entries: StereotypeCatalogEntryWire[],
): StereotypeCatalogCompileResult {
  return StereotypeCore.compileCatalog(entries);
}
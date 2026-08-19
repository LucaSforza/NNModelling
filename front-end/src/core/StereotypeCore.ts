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

import { compileTypeSignature } from "../type-system/schema";
import type { CompiledTypeSignatureV2 } from "../type-system/model";

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
  type_signature?: unknown;
}

export class StereotypeCore {
  public readonly id: string;
  public readonly name: string;
  public readonly category: string;
  public readonly pythonClassName: string;
  public readonly taskType: string;
  public readonly parameters: Record<string, ModuleParameter>;
  public readonly view: StereotypeView;
  public readonly typeSignature?: CompiledTypeSignatureV2;
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

    this.typeSignature = StereotypeCore.compileTypeSignature(filePath, data.type_signature, Object.keys(this.parameters));

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
    const files = import.meta.glob('../../../Stereotypes/**/*.json', { eager: true }) as Record<string, unknown>;
    const loaded: StereotypeCore[] = [];
    const failures: Error[] = [];

    for (const [path, rawData] of Object.entries(files)) {
      const jsonData = StereotypeCore.unwrapModule(rawData);
      try {
        loaded.push(new StereotypeCore(path, jsonData));
      } catch (e) {
        failures.push(e instanceof Error ? e : new Error(`${path}: ${String(e)}`));
      }
    }

    if (failures.length > 0) throw new AggregateError(failures, "Failed to load stereotype type signatures");

    return loaded.sort((a, b) => a.name.localeCompare(b.name));
  }

  private static compileTypeSignature(filePath: string, raw: unknown, parameterNames: Iterable<string>): CompiledTypeSignatureV2 | undefined {
    if (raw === undefined) return undefined;
    const compiled = compileTypeSignature(raw, { parameterNames });
    if (compiled.ok) return compiled.value;
    throw new Error(`${filePath}: ${compiled.errors.map(error => `${error.pointer || "/"}: ${error.message}`).join("; ")}`);
  }

  private static unwrapModule(raw: unknown): StereotypeJson {
    if (raw && typeof raw === "object" && "default" in raw) return (raw as { default: StereotypeJson }).default;
    return raw as StereotypeJson;
  }
}

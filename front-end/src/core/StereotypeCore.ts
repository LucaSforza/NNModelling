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

export interface ObservableInput {
  id: string;
  label: string;
  required: boolean;
}

export interface ObservableContract {
  captureKind: "FORWARD_VALUE" | "BACKWARD_GRADIENT";
  supportedModes: string[];
  finalizePhase: string;
  defaultRetentionScope: string;
  supportedRetentionScopes: string[];
  defaultStorageStrategy: string;
  supportedStorageStrategies: string[];
  inputs: ObservableInput[];
  resultSchema: Record<string, unknown>;
}

export interface ObservablePoint {
  id: string;
  label: string;
  tensorType?: TypeSignature;
}

export interface StereotypeJson {
  category?: string;
  pythonClassName?: string;
  taskType?: "classification" | "regression";
  expr?: string;
  view?: Partial<StereotypeView>;
  params?: Record<string, ModuleParameter>;
  type_signature?: TypeSignature;
  observable?: ObservableContract;
  observablePoints?: ObservablePoint[];
}

export class StereotypeCore {
  public readonly id: string;
  public readonly name: string;
  public readonly category: string;
  public readonly pythonClassName: string;
  public readonly taskType: string;
  public readonly expr: string;
  public readonly parameters: Record<string, ModuleParameter>;
  public readonly view: StereotypeView;
  public readonly typeSignature?: TypeSignature;
  public readonly observable?: ObservableContract;
  public readonly observablePoints: ObservablePoint[];
  public readonly isJoin: boolean;
  public readonly isInput: boolean;
  public readonly isLoss: boolean;
  public readonly isSubFlow: boolean;
  public readonly isObservable: boolean;

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
    this.expr = data.expr || "";

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
    this.observable = data.observable;
    this.observablePoints = data.observablePoints ? [...data.observablePoints] : [];

    // Category flags
    this.isJoin   = data.category === "Join"   || filePath.includes("/Joins/");
    this.isInput  = data.category === "Input";
    this.isLoss   = data.category === "Loss";
    this.isSubFlow = data.category === "Subflow" || filePath.includes("/SubFlows/");
    // Category is authoritative; directory placement is only a loader detail.
    this.isObservable = data.category === "Observable";
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

  // ── Node.js loader (MCP server) ────────────────
  // Uses fs.readdirSync + JSON.parse for Node.js environments.
  // The stereotypesDir parameter is an absolute path to the Stereotypes/ directory.
  public static loadFromDirectoryNode(stereotypesDir: string): StereotypeCore[] {
    // Dynamic import to avoid bundling 'fs' and 'path' in the browser build
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");

    const loaded: StereotypeCore[] = [];

    function walkDir(dir: string): void {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.name.endsWith(".json")) {
          try {
            const content = fs.readFileSync(fullPath, "utf-8");
            const jsonData = JSON.parse(content);
            loaded.push(new StereotypeCore(fullPath, jsonData));
          } catch (e) {
            console.error(`Error loading stereotype from ${fullPath}:`, e);
          }
        }
      }
    }

    walkDir(stereotypesDir);
    return loaded.sort((a, b) => a.name.localeCompare(b.name));
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
    if (raw.kind === "observable") {
      return {
        kind: "observable",
        input: (raw.input as ShapePattern[]).map((pat) => pat.map((d) => StereotypeCore.stripDollar(d))),
      };
    }
    if (raw.kind === "join") {
      return {
        ...raw,
        input: raw.input.map((pattern) => pattern.map((dimension) => StereotypeCore.stripDollar(dimension))),
        output: raw.output.map((dimension) => StereotypeCore.stripDollar(dimension)),
      };
    }
    return {
      ...raw,
      input: raw.input.map((dimension) => StereotypeCore.stripDollar(dimension)),
      output: raw.output.map((dimension) => StereotypeCore.stripDollar(dimension)),
    };
  }

  private static stripDollar(dim: ShapeDimPattern): ShapeDimPattern {
    if (dim.kind === "symbolic" && dim.name.startsWith("$")) {
      return { ...dim, name: dim.name.slice(1) };
    }
    if (dim.kind === "computed") {
      // For expr-based computed dims, don't strip $ from inside the expression
      // string — the tokenizer handles $H, $*, etc.
      if (dim.expr) {
        return { ...dim, args: undefined };
      }
      // Legacy formula+args based computed dims: strip $ from args
      return {
        ...dim,
        args: dim.args?.map((a) => (a.startsWith("$") ? a.slice(1) : a)),
      };
    }
    return dim;
  }
}

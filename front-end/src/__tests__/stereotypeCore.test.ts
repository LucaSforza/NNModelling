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

import { describe, expect, it } from "vitest";
import { StereotypeCore, compileStereotypeCatalog } from "../core/StereotypeCore";

const builtinLinear = {
  id: "Stereotypes/Modules/Linear.json",
  name: "Linear",
  source: "builtin" as const,
  data: {
    category: "Layer",
    pythonClassName: "nn.Linear",
    view: { color: "#4779c4", width: 140, height: 60 },
    params: {
      in_features: { type: "int", default: "784" },
      out_features: { type: "int", default: "10" },
    },
  },
};

const projectLayer = {
  id: "project-stereotypes/FancyLayer.json",
  name: "FancyLayer",
  source: "project" as const,
  data: {
    category: "Layer",
    pythonClassName: "my_ops.FancyLayer",
    view: { color: "#12ab34" },
  },
};

const projectJoin = {
  id: "project-stereotypes/MyJoin.json",
  name: "MyJoin",
  source: "project" as const,
  data: { category: "Join" },
};

describe("runtime stereotype catalog", () => {
  it("builds StereotypeCore instances from runtime wire entries", () => {
    const result = compileStereotypeCatalog([builtinLinear, projectLayer]);
    expect(result.errors).toEqual([]);
    expect(result.stereotypes).not.toBeNull();
    const names = result.stereotypes!.map((s) => s.name).sort();
    expect(names).toEqual(["FancyLayer", "Linear"]);
  });

  it("derives the stereotype name and metadata from the catalog entry", () => {
    const result = compileStereotypeCatalog([projectLayer]);
    const stereo = result.stereotypes![0];
    expect(stereo.name).toBe("FancyLayer");
    expect(stereo.category).toBe("Layer");
    expect(stereo.pythonClassName).toBe("my_ops.FancyLayer");
    expect(stereo.view.color).toBe("#12ab34");
  });

  it("honours Join/Loss category flags for project entries", () => {
    const join = compileStereotypeCatalog([projectJoin]);
    expect(join.stereotypes![0].isJoin).toBe(true);

    const loss = compileStereotypeCatalog([
      { ...projectLayer, id: "project-stereotypes/MyLoss.json", data: { category: "Loss" } },
    ]);
    expect(loss.stereotypes![0].isLoss).toBe(true);
  });

  it("keeps built-in /Joins/ and /SubFlows/ path conventions", () => {
    const join = compileStereotypeCatalog([
      { id: "Stereotypes/Joins/Addition.json", name: "Addition", source: "builtin", data: {} },
    ]);
    expect(join.stereotypes![0].isJoin).toBe(true);

    const subflow = compileStereotypeCatalog([
      { id: "Stereotypes/SubFlows/Repeat.json", name: "Repeat", source: "builtin", data: { category: "Subflow" } },
    ]);
    expect(subflow.stereotypes![0].isSubFlow).toBe(true);
  });

  it("rejects the whole catalog without partial replacement when an entry is malformed", () => {
    const malformed = {
      ...projectLayer,
      id: "project-stereotypes/Broken.json",
      data: "not-an-object" as unknown as Record<string, unknown>,
    };
    const result = compileStereotypeCatalog([builtinLinear, malformed]);
    expect(result.stereotypes).toBeNull();
    expect(result.errors.some((e) => e.path === "project-stereotypes/Broken.json")).toBe(true);
  });

  it("rejects the whole catalog when project entries collide with a built-in name", () => {
    const collision = {
      ...projectLayer,
      id: "project-stereotypes/Linear.json",
    };
    const result = compileStereotypeCatalog([builtinLinear, collision]);
    expect(result.stereotypes).toBeNull();
    expect(result.errors.some((e) => e.path === "project-stereotypes/Linear.json")).toBe(true);
  });

  it("returns an empty, valid catalog for zero entries", () => {
    const result = compileStereotypeCatalog([]);
    expect(result.errors).toEqual([]);
    expect(result.stereotypes).toEqual([]);
  });
});

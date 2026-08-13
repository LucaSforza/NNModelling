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

import fc from "fast-check";
import { afterAll } from "vitest";
import { Diagram } from "../../Diagram.svelte";
import { stubWindow, unstubWindow } from "../helpers";

stubWindow();
afterAll(() => unstubWindow());

// ── fast-check arbitrary: a random diagram spec ──────────────────────

const moduleSpecArb = fc.record({
  stereo: fc.constantFrom("Linear", "Tanh", "ReLU", "Sigmoid", "Fork", "Dropout", "BatchNorm1d", "Flatten", "Conv2d"),
  x: fc.integer({ min: 0, max: 1000 }),
  y: fc.integer({ min: 0, max: 1000 }),
  color: fc.constantFrom("#4779c4", "#f4a460", "#27b376", "#cd5c5c", "#95a5a6"),
  params: fc.record({
    out_features: fc.option(fc.string(), { nil: undefined }),
    bias: fc.option(fc.constantFrom("True", "False"), { nil: undefined }),
  }),
});

const diagramSpecArb = fc.record({
  modules: fc.array(moduleSpecArb, { minLength: 0, maxLength: 6 }),
  layoutDirection: fc.constantFrom("vertical", "horizontal"),
});

// ── Build a Diagram from spec ─────────────────────────────────────

function buildDiagram(spec: {
  modules: Array<{
    stereo: string;
    x: number;
    y: number;
    color: string;
    params: Record<string, string | undefined>;
  }>;
  layoutDirection: "vertical" | "horizontal";
}): Diagram {
  const d = new Diagram();
  const stereo = d.getStereotype("Linear");
  if (!stereo) throw new Error("Linear not found");

  for (const m of spec.modules) {
    const s = d.getStereotype(m.stereo);
    if (!s) continue;
    const cleanParams: Record<string, { value: string }> = {};
    for (const [k, v] of Object.entries(m.params)) {
      if (v !== undefined) cleanParams[k] = { value: v };
    }
    d.addModule(s, m.x, m.y, { color: m.color, params: cleanParams });
  }
  d.layoutDirection = spec.layoutDirection;
  return d;
}

// ── Fuzzer #3 — Serialization Idempotence ───────────────────────────

describe("Fuzzer #3 — Serialization Idempotence", () => {

  it("export → import → export produces identical JSON (ignoring key order)", () => {
    fc.assert(
      fc.property(diagramSpecArb, (spec) => {
        const d = buildDiagram(spec);

        const json1 = d.exportToJson();
        const parsed1 = JSON.parse(json1);

        d.importFromJson(json1);

        const json2 = d.exportToJson();
        const parsed2 = JSON.parse(json2);

        expect(parsed2.nodes.length).toBe(parsed1.nodes.length);
        expect(parsed2.edges.length).toBe(parsed1.edges.length);
        expect(parsed2.layoutDirection).toBe(parsed1.layoutDirection);

        const sortById = (arr: any[]) => [...arr].sort((a: any, b: any) => (a.id || "").localeCompare(b.id || ""));
        const nodes1 = sortById(parsed1.nodes);
        const nodes2 = sortById(parsed2.nodes);
        const edges1 = sortById(parsed1.edges);
        const edges2 = sortById(parsed2.edges);

        for (let i = 0; i < nodes1.length; i++) {
          expect(nodes2[i].id).toBe(nodes1[i].id);
          expect(nodes2[i].data.name).toBe(nodes1[i].data.name);
          expect(nodes2[i].data.stereotype).toBe(nodes1[i].data.stereotype);
          expect(nodes2[i].data.color).toBe(nodes1[i].data.color);
          expect(nodes2[i].data.params).toEqual(nodes1[i].data.params);
          expect(nodes2[i].position).toEqual(nodes1[i].position);
        }

        for (let i = 0; i < edges1.length; i++) {
          expect(edges2[i].source).toBe(edges1[i].source);
          expect(edges2[i].target).toBe(edges1[i].target);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("Empty diagram (only Input) round-trips correctly", () => {
    const d = new Diagram();

    const json1 = d.exportToJson();
    d.importFromJson(json1);
    const json2 = d.exportToJson();

    expect(JSON.parse(json2)).toEqual(JSON.parse(json1));
  });

  it("Invalid JSON does not crash the diagram", () => {
    const d = new Diagram();
    expect(() => d.importFromJson("not valid json")).not.toThrow();
    expect(d.nodes.length).toBeGreaterThanOrEqual(1);
  });
});

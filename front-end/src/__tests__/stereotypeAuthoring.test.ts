import { describe, expect, test } from "vitest"
import { parseDefinition, parseManifest } from "../type-system/packages/validation"
import { generateStereotypePackage, validateStereotypeAuthoringRequest, type StereotypeAuthoringRequest } from "../stereotype-authoring"

const request = (overrides: Partial<StereotypeAuthoringRequest> = {}): StereotypeAuthoringRequest => ({
  id: "model.identity",
  version: "1.2.0",
  directory: "packages/model-identity",
  name: "Model identity",
  description: "A readable generated package",
  kind: "layer",
  view: { color: "#123456", width: 180, height: 100 },
  dependencies: { "core.relu": "^0.1.0" },
  parameters: [],
  ...overrides,
})

describe("stereotype authoring domain", () => {
  test("renders four deterministic resources and one model-relative reference", () => {
    const first = generateStereotypePackage(request({
      parameters: [
        { name: "zeta", definition: { type: "boolean", default: false, position: "bottom" } },
        { name: "alpha", definition: { type: "integer", minimum: 1, maximum: 4, default: 2, position: "top" } },
      ],
    }))
    const second = generateStereotypePackage(request({
      parameters: [
        { name: "alpha", definition: { type: "integer", minimum: 1, maximum: 4, default: 2, position: "top" } },
        { name: "zeta", definition: { type: "boolean", default: false, position: "bottom" } },
      ],
    }))

    expect(Object.keys(first.files)).toEqual(["manifest.json", "stereotype.json", "inference.lua", "pytorch.py"])
    expect(first.modelPackage).toEqual({ id: "model.identity", version: "1.2.0", path: "packages/model-identity" })
    expect(first.files).toEqual(second.files)
    expect(parseManifest(JSON.parse(first.files["manifest.json"]))).toEqual(first.manifest)
    expect(parseDefinition(JSON.parse(first.files["stereotype.json"]))).toEqual(first.definition)
    expect(first.definition.parameters).toEqual({
      alpha: { type: "integer", minimum: 1, maximum: 4, default: 2, position: "top" },
      zeta: { type: "boolean", default: false, position: "bottom" },
    })
  })

  test("supports every parameter variant and its conditional fields", () => {
    const generated = generateStereotypePackage(request({
      parameters: [
        { name: "integer", definition: { type: "integer", minimum: 0, maximum: 8, default: 3, position: "top" } },
        { name: "number", definition: { type: "number", minimum: -1, maximum: 1, default: 0.5, position: "bottom" } },
        { name: "flag", definition: { type: "boolean", default: true, position: "top" } },
        { name: "text", definition: { type: "string", choices: ["a", "b"], default: "a", position: "bottom" } },
        { name: "dtype", definition: { type: "dtype", choices: ["float32", "int64"], default: "float32", position: "top" } },
        { name: "shape", definition: { type: "shape", default: ["B", 4], position: "bottom" } },
        { name: "list", definition: { type: "list", items: { type: "integer", minimum: 0 }, minItems: 1, maxItems: 3, default: [1], position: "top" } },
        { name: "stereotype", definition: { type: "stereotype", kind: "layer", default: { id: "core.relu", version: "^0.1.0", parameters: {} }, position: "bottom" } },
      ],
    }))
    expect(Object.values(generated.definition.parameters).every((parameter) => parameter.position === "top" || parameter.position === "bottom")).toBe(true)
    expect(generated.definition.parameters.list).toEqual({ type: "list", items: { type: "integer", minimum: 0 }, minItems: 1, maxItems: 3, default: [1], position: "top" })
  })

  test("requires unique names, explicit position, safe identity and dependencies", () => {
    expect(() => generateStereotypePackage(request({ parameters: [
      { name: "same", definition: { type: "boolean", position: "top" } },
      { name: "same", definition: { type: "boolean", position: "bottom" } },
    ] }))).toThrow(/unique/)
    expect(() => generateStereotypePackage(request({ parameters: [
      { name: "missingPosition", definition: { type: "boolean" } as never },
    ] }))).toThrow(/position/)
    expect(() => generateStereotypePackage(request({ id: "Model.Identity" }))).toThrow(/id/)
    expect(() => generateStereotypePackage(request({ version: "1.0" }))).toThrow(/version/)
    expect(() => generateStereotypePackage(request({ directory: "../outside" }))).toThrow(/relative/)
    expect(() => generateStereotypePackage(request({ dependencies: { "model.identity": "1.2.0" } }))).toThrow(/itself/)
    expect(() => generateStereotypePackage(request({ dependencies: { "core.relu": "latest" } }))).toThrow(/dependency/)
  })

  test("uses identity only for layers and explicit unsupported scaffolds for other kinds", () => {
    for (const kind of ["input", "loss", "join", "subflow", "output"] as const) {
      const generated = generateStereotypePackage(request({ id: `model.${kind}`, kind }))
      expect(generated.files["inference.lua"]).toContain(`Generated ${kind} stereotype is not implemented`)
      expect(generated.files["pytorch.py"]).toContain(`Generated ${kind} stereotype is not implemented`)
    }
    const layer = generateStereotypePackage(request())
    expect(layer.files["inference.lua"]).toContain("output = context.inputs[1]")
    expect(layer.files["pytorch.py"]).toContain("torch.nn.Identity()")
  })

  test("gives loss packages the required structural target binding without inventing a loss", () => {
    const generated = generateStereotypePackage(request({ id: "model.loss", kind: "loss" }))
    expect(generated.definition.objective).toEqual({ externalInputs: [{ name: "target", source: "batch.targets.target" }] })
    const explicit = generateStereotypePackage(request({
      id: "model.loss.explicit",
      kind: "loss",
      objective: { externalInputs: [{ name: "target", source: "batch.targets.target", transform: "flatten_batch" }] },
    }))
    expect(explicit.definition.objective).toEqual({ externalInputs: [{ name: "target", source: "batch.targets.target", transform: "flatten_batch" }] })
    expect(validateStereotypeAuthoringRequest(request({
      id: "model.loss",
      kind: "loss",
      objective: { externalInputs: [{ name: "target", source: "batch.targets.target" }] },
    })).kind).toBe("loss")
  })
})

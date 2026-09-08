import { describe, expect, test } from "vitest"
import StereotypeForm, { parseDependencyText, validateFormRequest } from "../components/StereotypeForm.svelte"
import type { StereotypeAuthoringRequest } from "../stereotype-authoring"

const request: StereotypeAuthoringRequest = {
  id: "model.attention",
  version: "1.0.0",
  directory: "packages/model-attention",
  name: "Attention",
  kind: "layer",
  view: { color: "#123456", width: 180, height: 100 },
  dependencies: { "core.relu": "^1.0.0" },
  parameters: [],
}

describe("StereotypeForm domain seam", () => {
  test("exports a Svelte component and parses line-oriented dependencies", () => {
    expect(StereotypeForm).toBeDefined()
    expect(parseDependencyText("core.relu ^1.0.0\ncore.linear: 2.0.0")).toEqual({ "core.relu": "^1.0.0", "core.linear": "2.0.0" })
  })

  test("uses T03 validation and preserves actionable rejection", () => {
    expect(validateFormRequest(request).id).toBe(request.id)
    expect(() => parseDependencyText("core.relu")).toThrow(/line 1/)
    expect(() => parseDependencyText("core.relu 1.0.0\ncore.relu 2.0.0")).toThrow(/duplicated/)
    expect(() => validateFormRequest({ ...request, id: "Model.Bad" })).toThrow(/id/)
  })
})

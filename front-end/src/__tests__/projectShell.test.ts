import { describe, expect, test } from "vitest"

import { createEmptyProjectJson, manifestFromProjectForm } from "../utils"

describe("project-first editor shell", () => {
  test("creates a canonical v2 manifest and empty custom package/dataset sets", () => {
    const manifest = manifestFromProjectForm({
      id: "  vision.mnist ",
      version: " 1.2.3 ",
      name: "  Vision model ",
      description: "  handwritten digits ",
    })

    expect(manifest).toEqual({
      schemaVersion: 2,
      id: "vision.mnist",
      version: "1.2.3",
      name: "Vision model",
      description: "handwritten digits",
      customPackages: [],
      customDatasets: [],
    })
    expect(JSON.parse(createEmptyProjectJson(manifest))).toEqual({
      nodes: [],
      edges: [],
      layoutDirection: "vertical",
      manifest,
    })
  })

  test("uses the canonical validator for invalid identity and version", () => {
    expect(() => manifestFromProjectForm({ id: "Not valid", version: "1.0.0", name: "Model" }))
      .toThrow(/invalid-identity at model manifest id/)
    expect(() => manifestFromProjectForm({ id: "model", version: "latest", name: "Model" }))
      .toThrow(/invalid-identity at model manifest version/)
  })
})

import { describe, expect, test } from "vitest"

import { loadProjectDatasetResources } from "../project-workspace/project-dataset-resources"

const MODEL = JSON.stringify({
  manifest: {
    schemaVersion: 2,
    id: "example.vae",
    version: "1.0.0",
    name: "VAE",
    customPackages: [],
    customDatasets: [{ id: "example.vae-mnist", version: "1.0.0", path: "datasets/vae-mnist" }],
  },
  nodes: [],
  edges: [],
})

const DATASET_MANIFEST = JSON.stringify({
  schemaVersion: 1,
  id: "example.vae-mnist",
  version: "1.0.0",
  entrypoints: { definition: "dataset.json", python: "dataset.py" },
})

const DATASET_DEFINITION = JSON.stringify({
  schemaVersion: 1,
  id: "example.vae-mnist",
  version: "1.0.0",
  name: "VAE MNIST",
  parameters: [],
  batch: {
    inputs: { image: { shape: ["B", 1, 28, 28], dtype: "float32" } },
    targets: { reconstruction: { shape: ["B", 1, 28, 28], dtype: "float32" } },
  },
})

const RESOURCES = {
  "datasets/vae-mnist/manifest.json": DATASET_MANIFEST,
  "datasets/vae-mnist/dataset.json": DATASET_DEFINITION,
  "datasets/vae-mnist/dataset.py": "def build(parameters, context): pass\n",
  "datasets/vae-mnist/data/train.pt": new Uint8Array([1, 2, 3]),
} as const

describe("project dataset resource loading", () => {
  test("reads the manifest inside the model document and materializes its closure", () => {
    const loaded = loadProjectDatasetResources({ modelJson: MODEL, resources: RESOURCES })

    expect(loaded.infos).toHaveLength(1)
    expect(loaded.infos[0]?.reference).toEqual({
      kind: "project",
      id: "example.vae-mnist",
      version: "1.0.0",
      ref: "project_example_vae-mnist_1_0_0",
    })
    expect(loaded.resources.get("project_example_vae-mnist_1_0_0")?.dataFiles).toEqual([
      { path: "train.pt", bytes: new Uint8Array([1, 2, 3]) },
    ])
  })

  test("surfaces malformed project dataset resources", () => {
    const resources = { ...RESOURCES, "datasets/vae-mnist/dataset.json": "{}" }

    expect(() => loadProjectDatasetResources({ modelJson: MODEL, resources })).toThrow(/unknown-version/)
  })

  test.each([
    ["manifest", { ...RESOURCES, "datasets/vae-mnist/manifest.json": DATASET_MANIFEST.replace("example.vae-mnist", "other.dataset") }],
    ["definition", { ...RESOURCES, "datasets/vae-mnist/dataset.json": DATASET_DEFINITION.replace("\"1.0.0\"", "\"2.0.0\"") }],
  ])("rejects %s identity mismatches", (_file, resources) => {
    expect(() => loadProjectDatasetResources({ modelJson: MODEL, resources })).toThrow(/invalid-identity.*id\/version/)
  })

  test("rejects project dataset paths outside datasets", () => {
    const model = MODEL.replace("datasets/vae-mnist", "resources/vae-mnist")

    expect(() => loadProjectDatasetResources({ modelJson: model, resources: RESOURCES })).toThrow(/invalid-path.*path/)
  })
})

import { afterAll, describe, expect, test, vi } from "vitest"

import { Diagram } from "../Diagram.svelte"
import type { DatasetDefinition } from "../project-workspace/dataset-contract"
import { stubWindow, unstubWindow } from "./helpers"

stubWindow()
afterAll(() => unstubWindow())

const dataset: DatasetDefinition = {
  schemaVersion: 1,
  id: "qa.images",
  version: "1.0.0",
  name: "QA images",
  parameters: [],
  batch: {
    inputs: { input: { shape: [4, 28], dtype: "float32" } },
    targets: {},
  },
}

describe("Diagram dataset catalog lifecycle", () => {
  test("publishes Input inference immediately after catalog replacement", async () => {
    const diagram = new Diagram()
    await diagram.waitForPackageRuntime()

    const input = diagram.nodes.find((node) => node.data?.package && (node.data.package as { id?: string }).id === "core.input")
    expect(input).toBeDefined()

    diagram.setDatasetInferenceContext({ definition: dataset, parameters: {} })
    expect(diagram.typeResult?.nodes.get(input!.id)).toMatchObject({ status: "unresolved" })

    const refresh = vi.spyOn(diagram, "refreshTypes")
    diagram.setDatasetCatalog([dataset])

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(diagram.typeResult?.nodes.get(input!.id)).toEqual({
      status: "success",
      output: { shape: [4, 28], dtype: "float32" },
    })

    diagram.setDatasetCatalog([])
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(diagram.typeResult?.nodes.get(input!.id)).toMatchObject({ status: "unresolved" })
  })
})

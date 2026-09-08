import { describe, expect, test } from "vitest"

import { readModelBundleFiles, type ModelBundleUploadFile } from "../utils"

function file(path: string, contents: string): ModelBundleUploadFile {
  return {
    name: path.split("/").at(-1)!,
    webkitRelativePath: path,
    text: async () => contents,
  }
}

describe("model bundle upload", () => {
  test("strips the selected directory root and preserves package resources", async () => {
    const loaded = await readModelBundleFiles([
      file("variational-autoencoder/model.json", '{"manifest":{"customPackages":[]}}'),
      file("variational-autoencoder/packages/sampling/manifest.json", "manifest"),
      file("variational-autoencoder/packages/sampling/pytorch.py", "python"),
    ])

    expect(loaded.modelJson).toContain("customPackages")
    expect(loaded.resources).toEqual({
      "model.json": '{"manifest":{"customPackages":[]}}',
      "packages/sampling/manifest.json": "manifest",
      "packages/sampling/pytorch.py": "python",
    })
  })

  test("rejects a directory without exactly one model.json", async () => {
    await expect(readModelBundleFiles([file("model.json", "one"), file("nested/model.json", "two")]))
      .rejects.toThrow("un solo model.json")
  })
})

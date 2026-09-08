import { describe, expect, it } from "vitest"
import { buildDatasetArchive } from "../training/dataset-bundle"
import type { GeneratedDatasetResources } from "../project-workspace/dataset-authoring"

function resources(dataFiles: readonly { path: string; bytes: Uint8Array }[] = []): GeneratedDatasetResources {
  return {
    manifest: {} as GeneratedDatasetResources["manifest"],
    definition: {} as GeneratedDatasetResources["definition"],
    modelDataset: { id: "demo.tokens", version: "1.0.0", path: "datasets/tokens" },
    files: {
      "manifest.json": '{"schemaVersion":1}',
      "dataset.json": '{"batch":{"inputs":{},"targets":{}}}',
      "dataset.py": "raise RuntimeError('worker only')\n",
    },
    dataFiles,
  }
}

describe("dataset archive transport", () => {
  it("is deterministic, sorted, digest-addressed and reports progress", async () => {
    const progress: string[] = []
    const first = await buildDatasetArchive(resources([
      { path: "z.bin", bytes: new Uint8Array([3]) },
      { path: "a.bin", bytes: new Uint8Array([1, 2]) },
    ]), { onProgress: (item) => progress.push(`${item.phase}:${item.transferredBytes}/${item.totalBytes}`) })
    const second = await buildDatasetArchive(resources([
      { path: "a.bin", bytes: new Uint8Array([1, 2]) },
      { path: "z.bin", bytes: new Uint8Array([3]) },
    ]))

    expect(first.format).toBe("zip")
    expect(first.bytes).toEqual(second.bytes)
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(first.size).toBe(first.bytes.byteLength)
    expect(first.files).toEqual(["data/a.bin", "data/z.bin", "dataset.json", "dataset.py", "manifest.json"])
    expect(progress.at(-1)).toBe(`digesting:${first.size}/${first.size}`)
    expect(first.bytes.slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))
  })

  it("rejects path escapes before producing an archive", async () => {
    await expect(buildDatasetArchive(resources([{ path: "../escape", bytes: new Uint8Array([1]) }]))).rejects.toThrow(/confined/)
  })

  it("enforces the encoded backend limit before digest publication", async () => {
    await expect(buildDatasetArchive(resources(), { maxBytes: 1 })).rejects.toThrow(/maximum size/)
  })
})

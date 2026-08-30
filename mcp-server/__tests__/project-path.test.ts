import { describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { openProjectAtPath, validateProjectPath } from "../src/project-path"

describe("project path boundary", () => {
  test("accepts a canonical model directory under the configured root", () => {
    expect(validateProjectPath("/tmp/projects/demo.model", "/tmp/projects")).toBe("/tmp/projects/demo.model")
  })

  test("rejects relative, traversal, root and invalid model paths", () => {
    expect(() => validateProjectPath("demo", "/tmp/projects")).toThrow("absolute canonical")
    expect(() => validateProjectPath("/tmp/projects/../escape", "/tmp/projects")).toThrow("absolute canonical")
    expect(() => validateProjectPath("/tmp/projects", "/tmp/projects")).toThrow("inside")
    expect(() => validateProjectPath("/tmp/projects/Not Valid", "/tmp/projects")).toThrow("lowercase model ID")
  })

  test("rejects paths outside the configured root and NUL bytes", () => {
    expect(() => validateProjectPath("/tmp/other/demo", "/tmp/projects")).toThrow("inside")
    expect(() => validateProjectPath("/tmp/projects/demo\0file", "/tmp/projects")).toThrow("non-empty")
  })

  test("opens the VAE fixture as UTF-8 while preserving binary resources", async () => {
    const fixturePath = fileURLToPath(new URL("../../examples/diagrams/package/models/variational-autoencoder", import.meta.url))
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "nnm-project-"))
    const projectPath = path.join(parent, "example.vae-mnist")
    await fs.cp(fixturePath, projectPath, { recursive: true })
    const binary = Uint8Array.from([0, 1, 127, 128, 255])
    await fs.writeFile(path.join(projectPath, "weights.bin"), binary)

    try {
      const payload = await openProjectAtPath(projectPath, parent)
      const modelJson = await fs.readFile(path.join(fixturePath, "model.json"), "utf8")
      expect(payload.modelJson).toBe(modelJson)
      expect(payload.resources["model.json"]).toEqual({ encoding: "utf8", data: modelJson })
      expect(payload.resources["weights.bin"]).toEqual({ encoding: "base64", data: Buffer.from(binary).toString("base64") })
    } finally {
      await fs.rm(parent, { recursive: true, force: true })
    }
  })
})

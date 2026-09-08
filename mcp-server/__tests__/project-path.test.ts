import { describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { applyProjectResource, openProjectAtPath, validateProjectPath, validateProjectResourcePath } from "../src/project-path"

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
    const projectPath = path.join(parent, "variational-autoencoder")
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

  test("writes and removes project resources under the validated project root", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "nnm-project-"))
    const projectPath = path.join(parent, "demo")
    await fs.mkdir(projectPath)
    try {
      await applyProjectResource(projectPath, parent, { kind: "write", path: "datasets/demo/data/sample.bin", encoding: "base64", data: "AH//" })
      expect(await fs.readFile(path.join(projectPath, "datasets/demo/data/sample.bin"))).toEqual(Buffer.from([0, 127, 255]))
      await applyProjectResource(projectPath, parent, { kind: "write", path: "datasets/demo/dataset.json", encoding: "utf8", data: "{}" })
      await applyProjectResource(projectPath, parent, { kind: "remove", path: "datasets/demo", recursive: true })
      await expect(fs.stat(path.join(projectPath, "datasets/demo"))).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await fs.rm(parent, { recursive: true, force: true })
    }
  })

  test("reopens replaced binary resources while preserving untouched files", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "nnm-project-"))
    const projectPath = path.join(parent, "demo")
    await fs.mkdir(projectPath)
    try {
      const modelJson = JSON.stringify({ nodes: [], edges: [], manifest: { schemaVersion: 1, id: "demo", version: "1.0.0", name: "Demo" } })
      await applyProjectResource(projectPath, parent, { kind: "write", path: "model.json", encoding: "utf8", data: modelJson })
      await applyProjectResource(projectPath, parent, { kind: "write", path: "datasets/demo/data/train.bin", encoding: "base64", data: "AQID" })
      await applyProjectResource(projectPath, parent, { kind: "write", path: "datasets/demo/data/untouched.bin", encoding: "base64", data: "BAUG" })
      await applyProjectResource(projectPath, parent, { kind: "write", path: "datasets/demo/data/train.bin", encoding: "base64", data: "BwgJ" })

      const reopened = await openProjectAtPath(projectPath, parent)
      expect(reopened.resources["datasets/demo/data/train.bin"]).toEqual({ encoding: "base64", data: "BwgJ" })
      expect(reopened.resources["datasets/demo/data/untouched.bin"]).toEqual({ encoding: "base64", data: "BAUG" })
      expect(await fs.readFile(path.join(projectPath, "datasets/demo/data/untouched.bin"))).toEqual(Buffer.from([4, 5, 6]))
    } finally {
      await fs.rm(parent, { recursive: true, force: true })
    }
  })

  test("opens project resources larger than the training upload limit", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "nnm-project-"))
    const projectPath = path.join(parent, "demo")
    await fs.mkdir(projectPath)
    try {
      const modelJson = JSON.stringify({ nodes: [], edges: [], manifest: { schemaVersion: 1, id: "demo", version: "1.0.0", name: "Demo" } })
      const data = Buffer.alloc(64 * 1024 * 1024 + 1, 1)
      await fs.writeFile(path.join(projectPath, "model.json"), modelJson)
      await fs.writeFile(path.join(projectPath, "dataset.bin"), data)

      const opened = await openProjectAtPath(projectPath, parent)
      const reopened = Buffer.from(opened.resources["dataset.bin"].data, "base64")
      expect(reopened.byteLength).toBe(data.byteLength)
      expect(reopened[0]).toBe(1)
      expect(reopened.at(-1)).toBe(1)
    } finally {
      await fs.rm(parent, { recursive: true, force: true })
    }
  })

  test("rejects resource traversal and project-root deletion", () => {
    expect(() => validateProjectResourcePath("/tmp/projects/demo", "/tmp/projects", "../outside")).toThrow("below the project")
    expect(() => validateProjectResourcePath("/tmp/projects/demo", "/tmp/projects", "")).toThrow("non-empty")
    expect(() => validateProjectResourcePath("/tmp/projects/demo", "/tmp/projects", "..")).toThrow("below the project")
  })
})

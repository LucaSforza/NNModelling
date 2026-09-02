import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "vitest"
import { parseModelManifest } from "../core/types"

import type { ModelInferenceRequest, ProtocolResponse } from "../../tests/differential/protocol"

const frontendRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const repositoryRoot = resolve(frontendRoot, "..")
const differentialRoot = resolve(frontendRoot, "tests/differential")
const oracleRevision = "ef3efb1859b4a9c19227dd55aade65767fd4b1f5"

const models = [
  ["transformer", ["B", "T", 512], "float32"],
  ["variational-autoencoder", ["B", 784], "float32"],
  ["resnet", ["B", 224, 224, 1000], "float32"],
] as const

describe("model semantic conformance", () => {
  test.each([
    ["resnet", {
      schemaVersion: 2,
      id: "example.resnet-mnist",
      version: "0.1.0",
      name: "ResNet",
      customPackages: [],
      customDatasets: [],
    }],
    ["vae", {
      schemaVersion: 2,
      id: "example.vae-mnist",
      version: "0.1.0",
      name: "Variational Autoencoder",
      description: "MNIST variational autoencoder",
      customPackages: [
        { id: "example.vae.sampling", version: "0.1.0", path: "packages/sampling" },
        { id: "example.vae.kl-divergence", version: "0.1.0", path: "packages/kl-divergence" },
      ],
      customDatasets: [],
    }],
  ])("parses %s model manifest deterministically", (_model, manifest) => {
    const first = parseModelManifest(manifest)
    const second = parseModelManifest(JSON.parse(JSON.stringify(manifest)))
    expect(first).toEqual(manifest)
    expect(second).toEqual(first)
  })

  test.each(models)("candidate matches pinned oracle for %s", async (modelId, expectedShape, expectedDtype) => {
    const request = JSON.parse(await readFile(resolve(differentialRoot, "models", `${modelId}.json`), "utf8")) as ModelInferenceRequest
    const [candidate, oracle] = await Promise.all([
      runAdapter("candidate-adapter.ts", request),
      runAdapter("oracle-adapter.ts", request),
    ])

    expect(request.modelId).toBe(modelId)
    expect(oracle.revision).toBe(oracleRevision)
    expect(candidate.outcome).toEqual(oracle.outcome)
    expect(candidate.outcome).toEqual({
      status: "success",
      output: { shape: expectedShape, dtype: expectedDtype },
    })
  })
})

async function runAdapter(file: string, request: ModelInferenceRequest): Promise<ProtocolResponse> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("bun", [resolve(differentialRoot, file)], {
      cwd: repositoryRoot,
      env: { ...process.env, STEREOTYPE_LAB_DIR: resolve(repositoryRoot, ".cache/stereotype-lab") },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)))
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)))
    child.on("error", reject)
    child.on("close", code => {
      if (code !== 0) {
        reject(new Error(`adapter ${file} exited ${String(code)}: ${Buffer.concat(stderr).toString()}`))
        return
      }
      try {
        resolvePromise(JSON.parse(Buffer.concat(stdout).toString()) as ProtocolResponse)
      } catch (cause) {
        reject(new Error(`adapter ${file} returned invalid JSON: ${Buffer.concat(stdout).toString()}`, { cause }))
      }
    })
    child.stdin.end(JSON.stringify(request))
  })
}

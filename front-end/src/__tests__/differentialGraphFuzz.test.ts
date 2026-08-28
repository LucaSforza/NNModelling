import { spawn } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import fc from "fast-check"
import { describe, expect, test } from "vitest"
import type { ModelInferenceRequest, ProtocolResponse } from "../../tests/differential/protocol"

const frontendRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const repositoryRoot = resolve(frontendRoot, "..")
const differentialRoot = resolve(frontendRoot, "tests/differential")

type ShapeCase = { input: number; middle: number; output: number; dtype: "float16" | "bfloat16" | "float32" | "float64"; branch: boolean }

const shapeCaseArb = fc.record({
  input: fc.integer({ min: 1, max: 64 }),
  middle: fc.integer({ min: 1, max: 64 }),
  output: fc.integer({ min: 1, max: 64 }),
  dtype: fc.constantFrom("float16", "bfloat16", "float32", "float64"),
  branch: fc.boolean(),
})

function requestFor(value: ShapeCase): ModelInferenceRequest {
  const linear = (id: string, input: string, inputFeatures: number, outputFeatures: number) => ({
    id, packageId: "core.linear", parameters: { in_features: inputFeatures, out_features: outputFeatures, dtype: value.dtype }, inputs: [input],
  })
  const nodes: ModelInferenceRequest["nodes"] = [
    { id: "input", packageId: "core.input", parameters: { shape: ["B", value.input], dtype: value.dtype }, inputs: [] },
  ]
  if (value.branch) {
    nodes.push(linear("left", "input", value.input, value.middle))
    nodes.push(linear("right", "input", value.input, value.middle))
    nodes.push({ id: "join", packageId: "core.add", parameters: {}, inputs: ["left", "right"] })
    nodes.push(linear("output", "join", value.middle, value.output))
  } else {
    nodes.push(linear("middle", "input", value.input, value.middle))
    nodes.push(linear("output", "middle", value.middle, value.output))
  }
  return { protocolVersion: 2, operation: "infer-model", modelId: "transformer", packages: ["core.input", "core.linear", "core.add"], nodes, output: "output" }
}

describe("differential graph fuzzing", () => {
  test("valid complete DAGs compare and shrink deterministically", async () => {
    await fc.assert(fc.asyncProperty(shapeCaseArb, async value => {
      const request = requestFor(value)
      const [candidate, oracle] = await Promise.all([runAdapter("candidate-adapter.ts", request), runAdapter("oracle-adapter.ts", request)])
      expect(candidate.outcome).toEqual(oracle.outcome)
      expect(candidate.outcome).toEqual({ status: "success", output: { shape: ["B", value.output], dtype: value.dtype } })
    }), { numRuns: 25, endOnFailure: true })
  }, 120_000)

  test("one targeted parameter mutation remains an oracle-equal regression", async () => {
    await fc.assert(fc.asyncProperty(shapeCaseArb, async value => {
      const request = requestFor({ ...value, branch: true })
      const mutated = { ...request, nodes: request.nodes.map(node => node.id === "right"
        ? { ...node, parameters: { ...node.parameters, in_features: value.input + 1 } }
        : node) }
      const [candidate, oracle] = await Promise.all([runAdapter("candidate-adapter.ts", mutated), runAdapter("oracle-adapter.ts", mutated)])
      expect(candidate.outcome).toEqual(oracle.outcome)
      expect(candidate.outcome.status).toBe("error")
    }), { numRuns: 10, endOnFailure: true })
  }, 120_000)
})

async function runAdapter(file: string, request: ModelInferenceRequest): Promise<ProtocolResponse> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("bun", [resolve(differentialRoot, file)], { cwd: repositoryRoot, env: { ...process.env, STEREOTYPE_LAB_DIR: resolve(repositoryRoot, ".cache/stereotype-lab") }, stdio: ["pipe", "pipe", "pipe"] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)))
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)))
    child.on("error", reject)
    child.on("close", code => {
      if (code !== 0) return reject(new Error(`adapter ${file} exited ${String(code)}: ${Buffer.concat(stderr).toString()}`))
      try { resolvePromise(JSON.parse(Buffer.concat(stdout).toString()) as ProtocolResponse) }
      catch (cause) { reject(new Error(`adapter ${file} returned invalid JSON`, { cause })) }
    })
    child.stdin.end(JSON.stringify(request))
  })
}

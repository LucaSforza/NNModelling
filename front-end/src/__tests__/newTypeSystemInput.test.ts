import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, describe, expect, test } from "vitest"

import { coreInputPackage } from "../type-system/bundled/core-input"
import { TypeSystemHost } from "../type-system/host"
import type { InputInferenceRequest, ProtocolResponse } from "../../tests/differential/protocol"

const frontendRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const repositoryRoot = resolve(frontendRoot, "..")
const differentialRoot = resolve(frontendRoot, "tests/differential")
const oracleRevision = "ef3efb1859b4a9c19227dd55aade65767fd4b1f5"
const hosts: TypeSystemHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.dispose()
})

describe("new package type-system input slice", () => {
  test("activates core.input through Cordis and adapts its Lua result", async () => {
    const host = await TypeSystemHost.create([coreInputPackage])
    hosts.push(host)
    await host.activate("core.input")

    expect(host.isActive("core.input")).toBe(true)
    expect(host.inferForEditor("core.input", { kind: "input", inputs: [] }, {
      shape: ["B", 3, 32, 32],
      dtype: "float16",
    })).toEqual({
      status: "success",
      output: { shape: ["B", 3, 32, 32], dtype: "float16" },
    })

    await host.dispose()
    expect(host.isActive("core.input")).toBe(false)
  })

  test("keeps missing required shape unresolved before Lua", async () => {
    const host = await TypeSystemHost.create([coreInputPackage])
    hosts.push(host)
    await host.activate("core.input")

    expect(host.inferForEditor("core.input", { kind: "input", inputs: [] }, {})).toEqual({
      status: "unresolved",
      missingParameters: ["shape"],
    })
  })

  test("keeps a malformed Lua result distinct as a runtime fault", async () => {
    const host = await TypeSystemHost.create([{
      resources: {
        ...coreInputPackage.resources as Record<string, string>,
        "inference.lua": "return function() return { status = 'success' } end",
      },
    }])
    hosts.push(host)
    await host.activate("core.input")

    const result = host.inferForEditor("core.input", { kind: "input", inputs: [] }, {
      shape: ["B", 8],
      dtype: "float32",
    })
    expect(result.status).toBe("fault")
    if (result.status === "fault") {
      expect(result.fault.message).toContain("Lua inference fault")
      expect(result.fault.message).toContain("expected tensor type")
    }
  })

  test("rolls back activation when the Lua entrypoint cannot load", async () => {
    const host = await TypeSystemHost.create([{
      resources: {
        ...coreInputPackage.resources as Record<string, string>,
        "inference.lua": "return function(",
      },
    }])
    hosts.push(host)

    await expect(host.activate("core.input")).rejects.toThrow("activation failed")
    expect(host.isActive("core.input")).toBe(false)
  })

  test.each(["input-symbolic.json", "input-default-dtype.json"])(
    "matches the pinned oracle for %s",
    async (model) => {
      const request = JSON.parse(await readFile(resolve(differentialRoot, "models", model), "utf8")) as InputInferenceRequest
      const [candidate, oracle] = await Promise.all([
        runAdapter("candidate-adapter.ts", request),
        runAdapter("oracle-adapter.ts", request),
      ])

      expect(oracle.revision).toBe(oracleRevision)
      expect(candidate.outcome).toEqual(oracle.outcome)
    },
  )
})

async function runAdapter(file: string, request: InputInferenceRequest): Promise<ProtocolResponse> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("bun", [resolve(differentialRoot, file)], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        STEREOTYPE_LAB_DIR: resolve(repositoryRoot, ".cache/stereotype-lab"),
      },
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

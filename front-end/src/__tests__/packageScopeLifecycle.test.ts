import { afterEach, describe, expect, test } from "vitest"

import { EditorTypeSystemRuntime, type ModelBundleResources } from "../type-system/editor-runtime"
import { createInstalledPackageRecord } from "../type-system/packages/installed/records"
import type { InstalledPackageRecord } from "../type-system/packages/types"

let runtime: EditorTypeSystemRuntime | undefined

afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
})

describe("model-scoped package runtime", () => {
  test("starts with core packages only even when external records are installed", async () => {
    const core = await record("core.input", "input")
    const external = await record("vendor.layer", "layer", "external")
    runtime = await EditorTypeSystemRuntime.create({ bundled: [core], external: [external] })

    expect(runtime.availablePackages().map(({ id }) => id)).toEqual(["core.input"])
    expect(runtime.activationState("vendor.layer@1.0.0")).toBeUndefined()
  })

  test("replaces custom packages atomically and disposes the previous scope", async () => {
    const core = await record("core.input", "input")
    runtime = await EditorTypeSystemRuntime.create({ bundled: [core] })
    const vae = manifest("example.vae")
    const resnet = manifest("example.resnet")

    const vaeScope = await runtime.prepareModelScope(vae.manifest, vae.bundle)
    const oldCoordinator = vaeScope.coordinator
    await runtime.commitModelScope(vaeScope)
    expect(runtime.availablePackages().map(({ id }) => id)).toEqual(["core.input", "example.vae"])

    const resnetScope = await runtime.prepareModelScope(resnet.manifest, resnet.bundle)
    await runtime.commitModelScope(resnetScope)
    expect(runtime.availablePackages().map(({ id }) => id)).toEqual(["core.input", "example.resnet"])
    expect(oldCoordinator.status("example.vae@1.0.0")?.state).toBe("disposed")
  })

  test("does not mutate the active scope when model package preparation fails", async () => {
    const core = await record("core.input", "input")
    runtime = await EditorTypeSystemRuntime.create({ bundled: [core] })
    const valid = manifest("example.vae")
    const active = await runtime.switchModelScope(valid.manifest, valid.bundle)
    const before = runtime.availablePackages().map(({ id }) => id)

    await expect(runtime.prepareModelScope({
      ...valid.manifest,
      customPackages: [{ id: "example.missing", version: "1.0.0", path: "packages/missing" }],
    }, valid.bundle)).rejects.toThrow("missing manifest.json")

    expect(runtime.availablePackages().map(({ id }) => id)).toEqual(before)
    expect(runtime.activationState("example.vae@1.0.0")?.state).toBe("active")
    expect(active.coordinator.status("example.vae@1.0.0")?.state).toBe("active")
  })

  test("rejects a graph reference that is outside the declared model scope", async () => {
    const core = await record("core.input", "input")
    runtime = await EditorTypeSystemRuntime.create({ bundled: [core] })
    const model = manifest("example.vae")

    await expect(runtime.prepareModelScope(model.manifest, model.bundle, [
      { id: "vendor.undeclared", version: "1.0.0" },
    ])).rejects.toThrow("not declared by the model manifest")
    expect(runtime.availablePackages().map(({ id }) => id)).toEqual(["core.input"])
  })
})

function manifest(id: string) {
  return {
    manifest: {
      schemaVersion: 1 as const,
      id: `${id}-model`,
      version: "1.0.0",
      name: id,
      customPackages: [{ id, version: "1.0.0", path: "packages/custom" }],
    },
    bundle: packageBundle(id),
  }
}

function packageBundle(id: string): ModelBundleResources {
  const root = "packages/custom"
  return {
    [`${root}/manifest.json`]: JSON.stringify({
      schemaVersion: 1,
      id,
      version: "1.0.0",
      dependencies: {},
      entrypoints: {
        definition: "stereotype.json",
        inference: { language: "lua", file: "inference.lua" },
      },
    }),
    [`${root}/stereotype.json`]: JSON.stringify({
      name: id,
      kind: "layer",
      view: { color: "#123456", width: 100, height: 60 },
      parameters: {},
    }),
    [`${root}/inference.lua`]: "return function(context) return { status = 'success', output = context.inputs[1] } end",
  }
}

async function record(id: string, kind: "input" | "layer", source: "bundled" | "external" = "bundled"): Promise<InstalledPackageRecord> {
  const manifest = {
    schemaVersion: 1 as const,
    id,
    version: "1.0.0",
    dependencies: {},
    entrypoints: {
      definition: "stereotype.json",
      inference: { language: "lua" as const, file: "inference.lua" },
    },
  }
  const definition = {
    name: id,
    kind,
    view: { color: "#123456", width: 100, height: 60 },
    parameters: {},
  }
  return createInstalledPackageRecord({
    source,
    manifest,
    definition,
    resources: {
      "manifest.json": JSON.stringify(manifest),
      "stereotype.json": JSON.stringify(definition),
      "inference.lua": "return function(context) return { status = 'success', output = context.inputs[1] } end",
    },
  })
}

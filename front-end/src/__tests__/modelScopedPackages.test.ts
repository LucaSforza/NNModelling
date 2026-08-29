import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, describe, expect, test } from "vitest"

import { parseModelManifest } from "../core/types"
import { TypeSystemHost, type PackageSelection } from "../type-system/host"

import samplingManifest from "../../../examples/diagrams/package/models/variational-autoencoder/packages/sampling/manifest.json?raw"
import samplingDefinition from "../../../examples/diagrams/package/models/variational-autoencoder/packages/sampling/stereotype.json?raw"
import samplingInference from "../../../examples/diagrams/package/models/variational-autoencoder/packages/sampling/inference.lua?raw"
import klManifest from "../../../examples/diagrams/package/models/variational-autoencoder/packages/kl-divergence/manifest.json?raw"
import klDefinition from "../../../examples/diagrams/package/models/variational-autoencoder/packages/kl-divergence/stereotype.json?raw"
import klInference from "../../../examples/diagrams/package/models/variational-autoencoder/packages/kl-divergence/inference.lua?raw"

const modelPath = resolve(fileURLToPath(new URL("../../../examples/diagrams/package/models/variational-autoencoder/model.json", import.meta.url)))
const exampleIndexPath = resolve(fileURLToPath(new URL("../../../examples/manifest.json", import.meta.url)))
let host: TypeSystemHost | undefined

afterEach(async () => {
  await host?.dispose()
  host = undefined
})

describe("model-scoped VAE packages", () => {
  test("indexes package-native model bundles at their canonical paths", async () => {
    const index = JSON.parse(await readFile(exampleIndexPath, "utf8")) as {
      packageModels: Record<string, string>
    }

    expect(index.packageModels).toEqual({
      resnet: "diagrams/package/models/resnet/model.json",
      transformer: "diagrams/package/models/transformer/model.json",
      "variational-autoencoder": "diagrams/package/models/variational-autoencoder/model.json",
      "variational-autoencoder-simple": "diagrams/package/models/variational-autoencoder/simple.json",
    })
  })

  test("declares local package paths and exact identities", async () => {
    const model = JSON.parse(await readFile(modelPath, "utf8")) as { manifest: unknown }
    const manifest = parseModelManifest(model.manifest)

    expect(manifest.customPackages).toEqual([
      { id: "example.vae.sampling", version: "0.1.0", path: "packages/sampling" },
      { id: "example.vae.kl-divergence", version: "0.1.0", path: "packages/kl-divergence" },
    ])
    expect(manifest.customPackages.every(({ id }) => !id.startsWith("core."))).toBe(true)
  })

  test("loads and infers each package from the model-local resource set", async () => {
    host = await TypeSystemHost.create([
      packageSelection(samplingManifest, samplingDefinition, samplingInference),
      packageSelection(klManifest, klDefinition, klInference),
    ])
    await host.activate(ref("example.vae.sampling"))
    await host.activate(ref("example.vae.kl-divergence"))

    expect(host.packageDefinition(ref("example.vae.sampling"))?.name).toBe("Reparameterize")
    expect(host.packageDefinition(ref("example.vae.kl-divergence"))?.name).toBe("KL Divergence")
    expect(host.inferForEditor(ref("example.vae.sampling"), {
      kind: "layer",
      inputs: [{ shape: ["B", 64], dtype: "float32" }],
    }, { epsilon_scale: 1 })).toEqual({
      status: "success",
      output: { shape: ["B", 32], dtype: "float32" },
    })
    expect(host.inferForEditor(ref("example.vae.kl-divergence"), {
      kind: "loss",
      inputs: [{ shape: ["B", 64], dtype: "float32" }],
    }, {})).toEqual({
      status: "success",
      output: { shape: [], dtype: "float32" },
    })
  })
})

function packageSelection(manifest: string, definition: string, inference: string): PackageSelection {
  return { resources: { "manifest.json": manifest, "stereotype.json": definition, "inference.lua": inference } }
}

function ref(id: string, version = "0.1.0") { return { id, version, name: id } }

import { afterEach, describe, expect, test } from "vitest"

import type { PackageSelection } from "../type-system/host"
import { TypeSystemHost } from "../type-system/host"

import addManifest from "../../../stereotype-packages/core/add/manifest.json?raw"
import addDefinition from "../../../stereotype-packages/core/add/stereotype.json?raw"
import addInference from "../../../stereotype-packages/core/add/inference.lua?raw"
import castManifest from "../../../stereotype-packages/core/cast/manifest.json?raw"
import castDefinition from "../../../stereotype-packages/core/cast/stereotype.json?raw"
import castInference from "../../../stereotype-packages/core/cast/inference.lua?raw"
import concatManifest from "../../../stereotype-packages/core/concat/manifest.json?raw"
import concatDefinition from "../../../stereotype-packages/core/concat/stereotype.json?raw"
import concatInference from "../../../stereotype-packages/core/concat/inference.lua?raw"
import crossEntropyManifest from "../../../stereotype-packages/core/cross-entropy/manifest.json?raw"
import crossEntropyDefinition from "../../../stereotype-packages/core/cross-entropy/stereotype.json?raw"
import crossEntropyInference from "../../../stereotype-packages/core/cross-entropy/inference.lua?raw"
import embeddingManifest from "../../../stereotype-packages/core/embedding/manifest.json?raw"
import embeddingDefinition from "../../../stereotype-packages/core/embedding/stereotype.json?raw"
import embeddingInference from "../../../stereotype-packages/core/embedding/inference.lua?raw"
import horizontalRepeatManifest from "../../../stereotype-packages/core/horizontal-repeat/manifest.json?raw"
import horizontalRepeatDefinition from "../../../stereotype-packages/core/horizontal-repeat/stereotype.json?raw"
import horizontalRepeatInference from "../../../stereotype-packages/core/horizontal-repeat/inference.lua?raw"
import inputManifest from "../../../stereotype-packages/core/input/manifest.json?raw"
import inputDefinition from "../../../stereotype-packages/core/input/stereotype.json?raw"
import inputInference from "../../../stereotype-packages/core/input/inference.lua?raw"
import linearManifest from "../../../stereotype-packages/core/linear/manifest.json?raw"
import linearDefinition from "../../../stereotype-packages/core/linear/stereotype.json?raw"
import linearInference from "../../../stereotype-packages/core/linear/inference.lua?raw"
import matmulManifest from "../../../stereotype-packages/core/matmul/manifest.json?raw"
import matmulDefinition from "../../../stereotype-packages/core/matmul/stereotype.json?raw"
import matmulInference from "../../../stereotype-packages/core/matmul/inference.lua?raw"
import klDivergenceManifest from "../../../stereotype-packages/core/kl-divergence/manifest.json?raw"
import klDivergenceDefinition from "../../../stereotype-packages/core/kl-divergence/stereotype.json?raw"
import klDivergenceInference from "../../../stereotype-packages/core/kl-divergence/inference.lua?raw"
import mseLossManifest from "../../../stereotype-packages/core/mse-loss/manifest.json?raw"
import mseLossDefinition from "../../../stereotype-packages/core/mse-loss/stereotype.json?raw"
import mseLossInference from "../../../stereotype-packages/core/mse-loss/inference.lua?raw"
import outputManifest from "../../../stereotype-packages/core/output/manifest.json?raw"
import outputDefinition from "../../../stereotype-packages/core/output/stereotype.json?raw"
import outputInference from "../../../stereotype-packages/core/output/inference.lua?raw"
import positionalEncodingManifest from "../../../stereotype-packages/core/positional-encoding/manifest.json?raw"
import positionalEncodingDefinition from "../../../stereotype-packages/core/positional-encoding/stereotype.json?raw"
import positionalEncodingInference from "../../../stereotype-packages/core/positional-encoding/inference.lua?raw"
import reparameterizeManifest from "../../../stereotype-packages/core/reparameterize/manifest.json?raw"
import reparameterizeDefinition from "../../../stereotype-packages/core/reparameterize/stereotype.json?raw"
import reparameterizeInference from "../../../stereotype-packages/core/reparameterize/inference.lua?raw"
import repeatManifest from "../../../stereotype-packages/core/repeat/manifest.json?raw"
import repeatDefinition from "../../../stereotype-packages/core/repeat/stereotype.json?raw"
import repeatInference from "../../../stereotype-packages/core/repeat/inference.lua?raw"
import subflowProxyManifest from "../../../stereotype-packages/core/subflow-proxy/manifest.json?raw"
import subflowProxyDefinition from "../../../stereotype-packages/core/subflow-proxy/stereotype.json?raw"
import subflowProxyInference from "../../../stereotype-packages/core/subflow-proxy/inference.lua?raw"

const packages: readonly PackageSelection[] = [
  packageSelection(inputManifest, inputDefinition, inputInference),
  packageSelection(linearManifest, linearDefinition, linearInference),
  packageSelection(positionalEncodingManifest, positionalEncodingDefinition, positionalEncodingInference),
  packageSelection(addManifest, addDefinition, addInference),
  packageSelection(concatManifest, concatDefinition, concatInference),
  packageSelection(matmulManifest, matmulDefinition, matmulInference),
  packageSelection(castManifest, castDefinition, castInference),
  packageSelection(embeddingManifest, embeddingDefinition, embeddingInference),
  packageSelection(crossEntropyManifest, crossEntropyDefinition, crossEntropyInference),
  packageSelection(klDivergenceManifest, klDivergenceDefinition, klDivergenceInference),
  packageSelection(mseLossManifest, mseLossDefinition, mseLossInference),
  packageSelection(outputManifest, outputDefinition, outputInference),
  packageSelection(reparameterizeManifest, reparameterizeDefinition, reparameterizeInference),
  packageSelection(repeatManifest, repeatDefinition, repeatInference),
  packageSelection(horizontalRepeatManifest, horizontalRepeatDefinition, horizontalRepeatInference),
  packageSelection(subflowProxyManifest, subflowProxyDefinition, subflowProxyInference),
]

let host: TypeSystemHost | undefined

afterEach(async () => {
  await host?.dispose()
  host = undefined
})

describe("new core standard-library packages", () => {
  test("runs source, layer, join, loss, and output packages without a host switch", async () => {
    host = await TypeSystemHost.create(packages)
    for (const id of ["core.input", "core.linear", "core.positional-encoding", "core.add", "core.concat", "core.matmul", "core.cast", "core.embedding", "core.cross-entropy", "core.kl-divergence", "core.mse-loss", "core.output", "core.reparameterize", "core.repeat", "core.horizontal-repeat", "core.subflow-proxy"]) {
      await host.activate(id)
    }
    expect(host.packageDefinition("core.subflow-proxy")?.wheelAdapters).toEqual([expect.objectContaining({
      name: "forward",
      entrypoint: "module.forward",
      targetPolicy: "forbidden",
    })])

    expect(host.inferForEditor("core.input", { kind: "input", inputs: [] }, {
      shape: ["B", 3, 32, 32], dtype: "float32",
    })).toEqual({ status: "success", output: { shape: ["B", 3, 32, 32], dtype: "float32" } })

    expect(host.inferForEditor("core.linear", { kind: "layer", inputs: [{ shape: ["B", 128], dtype: "float32" }] }, {
      in_features: 128, out_features: 64,
    })).toEqual({ status: "success", output: { shape: ["B", 64], dtype: "float32" } })

    expect(host.inferForEditor("core.positional-encoding", { kind: "layer", inputs: [{ shape: ["B", "T", 64], dtype: "float32" }] }, {
      d_model: 64, max_len: 128,
    })).toEqual({ status: "success", output: { shape: ["B", "T", 64], dtype: "float32" } })

    expect(host.inferForEditor("core.positional-encoding", { kind: "layer", inputs: [{ shape: ["B", 64], dtype: "float32" }] }, {
      d_model: 64, max_len: 128,
    })).toEqual({ status: "error", message: "Positional Encoding expects a rank-3 input [B, L, D], got rank 2" })

    expect(host.inferForEditor("core.positional-encoding", { kind: "layer", inputs: [{ shape: ["B", "T", 32], dtype: "float32" }] }, {
      d_model: 64, max_len: 128,
    })).toEqual({ status: "error", message: "Positional Encoding expects embedding dimension 64, got 32" })

    expect(host.inferForEditor("core.concat", { kind: "join", inputs: [
      { shape: ["B", 16], dtype: "float32" },
      { shape: ["B", 32], dtype: "float32" },
      { shape: ["B", 8], dtype: "float32" },
    ] }, { dim: -1 })).toEqual({ status: "success", output: { shape: ["B", 56], dtype: "float32" } })

    expect(host.inferForEditor("core.add", { kind: "join", inputs: [
      { shape: ["B", 64], dtype: "float32" },
      { shape: ["B", 32], dtype: "float32" },
    ] }, {})).toEqual({ status: "error", message: "Add input 2 is incompatible with input 1" })

    expect(host.inferForEditor("core.matmul", { kind: "join", inputs: [
      { shape: [32, 64], dtype: "float32" },
      { shape: [64, 16], dtype: "float32" },
      { shape: [16, 8], dtype: "float32" },
    ] }, {})).toEqual({ status: "success", output: { shape: [32, 8], dtype: "float32" } })

    expect(host.inferForEditor("core.matmul", { kind: "join", inputs: [
      { shape: [32, 64], dtype: "float32" },
      { shape: [128, 16], dtype: "float32" },
    ] }, {})).toEqual({
      status: "error",
      message: "MatMul inner dimensions are incompatible: input 1 has 64, input 2 has 128",
    })

    expect(host.inferForEditor("core.cross-entropy", { kind: "loss", inputs: [{ shape: ["B", 10], dtype: "float32" }] }, {})).toEqual({
      status: "success", output: { shape: [], dtype: "float32" },
    })

    expect(host.inferForEditor("core.mse-loss", { kind: "loss", inputs: [{ shape: ["B", 1], dtype: "float32" }] }, {})).toEqual({
      status: "success", output: { shape: [], dtype: "float32" },
    })

    expect(host.inferForEditor("core.reparameterize", { kind: "layer", inputs: [{ shape: ["B", 64], dtype: "float32" }] }, { epsilon_scale: 0 })).toEqual({
      status: "success", output: { shape: ["B", 32], dtype: "float32" },
    })

    expect(host.inferForEditor("core.kl-divergence", { kind: "loss", inputs: [{ shape: ["B", 64], dtype: "float32" }] }, {})).toEqual({
      status: "success", output: { shape: [], dtype: "float32" },
    })

    expect(host.inferForEditor("core.output", { kind: "output", inputs: [{ shape: ["B", 10], dtype: "float32" }] }, {})).toEqual({
      status: "success", output: { shape: ["B", 10], dtype: "float32" },
    })
  })

  test("preserves explicit dtype behavior and rejects mismatches", async () => {
    host = await TypeSystemHost.create(packages)
    for (const id of ["core.linear", "core.cast", "core.embedding", "core.concat", "core.matmul"]) await host.activate(id)

    expect(host.inferForEditor("core.linear", { kind: "layer", inputs: [{ shape: ["B", 128], dtype: "float16" }] }, {
      in_features: 128, out_features: 64, dtype: "float16",
    })).toEqual({ status: "success", output: { shape: ["B", 64], dtype: "float16" } })

    expect(host.inferForEditor("core.cast", { kind: "layer", inputs: [{ shape: ["B", 56], dtype: "float32" }] }, {
      dtype: "int64",
    })).toEqual({ status: "success", output: { shape: ["B", 56], dtype: "int64" } })

    expect(host.inferForEditor("core.embedding", { kind: "layer", inputs: [{ shape: ["B", "T"], dtype: "int32" }] }, {
      num_embeddings: 1024, embedding_dim: 64, input_dtype: "int32", dtype: "float32",
    })).toEqual({ status: "success", output: { shape: ["B", "T", 64], dtype: "float32" } })

    expect(host.inferForEditor("core.embedding", { kind: "layer", inputs: [{ shape: ["B", "T"], dtype: "float16" }] }, {
      num_embeddings: 1024, embedding_dim: 64,
    })).toEqual({ status: "error", message: "Embedding expects input dtype int64, got float16" })

    expect(host.inferForEditor("core.concat", { kind: "join", inputs: [
      { shape: ["B", 16], dtype: "float32" },
      { shape: ["B", 8], dtype: "float16" },
    ] }, { dim: -1 })).toEqual({ status: "error", message: "Concat input 2 has dtype float16, expected float32" })

    expect(host.inferForEditor("core.matmul", { kind: "join", inputs: [
      { shape: [32, 64], dtype: "float32" },
      { shape: [64, 16], dtype: "float16" },
    ] }, {})).toEqual({ status: "error", message: "MatMul input 2 has dtype float16, expected float32" })

    expect(host.inferForEditor("core.matmul", { kind: "join", inputs: [
      { shape: [32, 64], dtype: "float32" },
      { shape: [64, 16], dtype: "float32" },
      { shape: [8, 4], dtype: "float32" },
    ] }, {})).toEqual({
      status: "error",
      message: "MatMul inner dimensions are incompatible: input 2 has 16, input 3 has 8",
    })
  })

  test("composes Repeat and Horizontal Repeat through their declared capabilities", async () => {
    host = await TypeSystemHost.create(packages)
    await host.activate("core.repeat")
    await host.activate("core.horizontal-repeat")
    await host.activate("core.concat")

    const repeated = host.inferForEditor("core.repeat", {
      kind: "subflow",
      inputs: [{ shape: ["B", 4], dtype: "float32" }],
      inferSubflow(input) {
        const features = input.shape.at(-1)
        return typeof features === "number"
          ? { status: "success", output: { shape: [...input.shape.slice(0, -1), features * 2], dtype: input.dtype } }
          : { status: "error", message: "numeric features required" }
      },
    }, { times: 3 })
    expect(repeated).toEqual({ status: "success", output: { shape: ["B", 32], dtype: "float32" } })

    const horizontal = host.inferForEditor("core.horizontal-repeat", {
      kind: "subflow",
      inputs: [{ shape: ["B", 16], dtype: "float32" }],
      inferSubflow: () => ({ status: "success", output: { shape: ["B", 8], dtype: "float32" } }),
    }, { times: 3 })
    expect(horizontal).toEqual({ status: "success", output: { shape: ["B", 24], dtype: "float32" } })
  })

  test("delegates Subflow Proxy to exactly one nested subflow", async () => {
    host = await TypeSystemHost.create(packages)
    await host.activate("core.subflow-proxy")
    let calls = 0

    expect(host.inferForEditor("core.subflow-proxy", {
      kind: "subflow",
      inputs: [{ shape: ["B", 4], dtype: "float32" }],
      inferSubflow: (input) => {
        calls += 1
        return { status: "success", output: input }
      },
    }, {})).toEqual({ status: "success", output: { shape: ["B", 4], dtype: "float32" } })
    expect(calls).toBe(1)
  })
})

function packageSelection(manifest: string, definition: string, inference: string): PackageSelection {
  return { resources: { "manifest.json": manifest, "stereotype.json": definition, "inference.lua": inference } }
}

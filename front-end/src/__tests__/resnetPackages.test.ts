import { afterEach, describe, expect, test } from "vitest"

import { TypeSystemHost } from "../type-system/host"
import type { PackageSelection } from "../type-system/host"

import addManifest from "../../../stereotype-packages/core/add/manifest.json?raw"
import addDefinition from "../../../stereotype-packages/core/add/stereotype.json?raw"
import addInference from "../../../stereotype-packages/core/add/inference.lua?raw"
import adaptiveManifest from "../../../stereotype-packages/core/adaptive-avg-pool2d/manifest.json?raw"
import adaptiveDefinition from "../../../stereotype-packages/core/adaptive-avg-pool2d/stereotype.json?raw"
import adaptiveInference from "../../../stereotype-packages/core/adaptive-avg-pool2d/inference.lua?raw"
import batchNormManifest from "../../../stereotype-packages/core/batch-norm2d/manifest.json?raw"
import batchNormDefinition from "../../../stereotype-packages/core/batch-norm2d/stereotype.json?raw"
import batchNormInference from "../../../stereotype-packages/core/batch-norm2d/inference.lua?raw"
import convManifest from "../../../stereotype-packages/core/conv2d/manifest.json?raw"
import convDefinition from "../../../stereotype-packages/core/conv2d/stereotype.json?raw"
import convInference from "../../../stereotype-packages/core/conv2d/inference.lua?raw"
import flattenManifest from "../../../stereotype-packages/core/flatten/manifest.json?raw"
import flattenDefinition from "../../../stereotype-packages/core/flatten/stereotype.json?raw"
import flattenInference from "../../../stereotype-packages/core/flatten/inference.lua?raw"
import maxPoolManifest from "../../../stereotype-packages/core/max-pool2d/manifest.json?raw"
import maxPoolDefinition from "../../../stereotype-packages/core/max-pool2d/stereotype.json?raw"
import maxPoolInference from "../../../stereotype-packages/core/max-pool2d/inference.lua?raw"
import reluManifest from "../../../stereotype-packages/core/relu/manifest.json?raw"
import reluDefinition from "../../../stereotype-packages/core/relu/stereotype.json?raw"
import reluInference from "../../../stereotype-packages/core/relu/inference.lua?raw"

const packages: readonly PackageSelection[] = [
  packageSelection(addManifest, addDefinition, addInference),
  packageSelection(adaptiveManifest, adaptiveDefinition, adaptiveInference),
  packageSelection(batchNormManifest, batchNormDefinition, batchNormInference),
  packageSelection(convManifest, convDefinition, convInference),
  packageSelection(flattenManifest, flattenDefinition, flattenInference),
  packageSelection(maxPoolManifest, maxPoolDefinition, maxPoolInference),
  packageSelection(reluManifest, reluDefinition, reluInference),
]

const tensor = (shape: readonly (string | number)[], dtype = "float32" as const) => ({ shape, dtype })

let host: TypeSystemHost | undefined

afterEach(async () => {
  await host?.dispose()
  host = undefined
})

describe("NNModelling ResNet product-mode packages", () => {
  test("composes a real NCHW residual path through pooling and the head", async () => {
    host = await TypeSystemHost.create(packages)
    for (const id of [
      "core.add",
      "core.adaptive-avg-pool2d",
      "core.batch-norm2d",
      "core.conv2d",
      "core.flatten",
      "core.max-pool2d",
      "core.relu",
    ]) await host.activate(id)

    const input = tensor(["B", 3, 224, 224])
    const conv1 = infer("core.conv2d", input, {
      in_channels: 3, out_channels: 64, kernel_size: 7, stride: 2, padding: 3,
    })
    expect(conv1).toEqual({ status: "success", output: tensor(["B", 64, 112, 112]) })
    const norm1 = infer("core.batch-norm2d", output(conv1), { num_features: 64 })
    expect(norm1).toEqual({ status: "success", output: tensor(["B", 64, 112, 112]) })
    const pooled = infer("core.max-pool2d", output(norm1), {
      kernel_size: 3, stride: 2, padding: 1,
    })
    expect(pooled).toEqual({ status: "success", output: tensor(["B", 64, 56, 56]) })

    const blockConv1 = infer("core.conv2d", output(pooled), {
      in_channels: 64, out_channels: 64, kernel_size: 3, padding: 1,
    })
    const blockNorm1 = infer("core.batch-norm2d", output(blockConv1), { num_features: 64 })
    const blockRelu = infer("core.relu", output(blockNorm1), {})
    const blockConv2 = infer("core.conv2d", output(blockRelu), {
      in_channels: 64, out_channels: 64, kernel_size: 3, padding: 1,
    })
    const blockNorm2 = infer("core.batch-norm2d", output(blockConv2), { num_features: 64 })
    const residual = host.inferForEditor("core.add", {
      kind: "join", inputs: [output(pooled), output(blockNorm2)],
    }, {})
    expect(residual).toEqual({ status: "success", output: tensor(["B", 64, 56, 56]) })

    const head = infer("core.adaptive-avg-pool2d", output(residual), { output_size: 1 })
    const flattened = infer("core.flatten", output(head), { start_dim: 1 })
    expect(flattened).toEqual({ status: "success", output: tensor(["B", 64]) })
  })

  test("reports channel, rank, and spatial-shape contract mismatches", async () => {
    host = await TypeSystemHost.create(packages)
    for (const id of ["core.batch-norm2d", "core.conv2d", "core.flatten", "core.max-pool2d"]) {
      await host.activate(id)
    }

    expect(host.inferForEditor("core.conv2d", {
      kind: "layer", inputs: [tensor(["B", 16, 32, 32])],
    }, { in_channels: 3, out_channels: 8, kernel_size: 3 })).toEqual({
      status: "error", message: "Conv2d expected 3 input channels, got 16",
    })
    expect(host.inferForEditor("core.batch-norm2d", {
      kind: "layer", inputs: [tensor(["B", 8, 32])],
    }, { num_features: 8 })).toEqual({
      status: "error", message: "BatchNorm2d expects a rank-4 tensor",
    })
    expect(host.inferForEditor("core.max-pool2d", {
      kind: "layer", inputs: [tensor(["B", 8, "H", "W"])],
    }, { kernel_size: 3 })).toEqual({
      status: "error", message: "MaxPool2d requires numeric spatial dimensions",
    })
    expect(host.inferForEditor("core.flatten", {
      kind: "layer", inputs: [tensor(["B", "C", 7, 7])],
    }, { start_dim: 1 })).toEqual({
      status: "error", message: "flatten requires numeric dimensions",
    })
  })
})

function infer(
  packageId: string,
  input: ReturnType<typeof tensor>,
  parameters: Readonly<Record<string, unknown>>,
) {
  return host!.inferForEditor(packageId, { kind: "layer", inputs: [input] }, parameters)
}

function output(result: ReturnType<TypeSystemHost["inferForEditor"]>) {
  if (result.status !== "success") throw new Error(`expected successful inference, got ${result.status}`)
  return result.output
}

function packageSelection(manifest: string, definition: string, inference: string): PackageSelection {
  return { resources: { "manifest.json": manifest, "stereotype.json": definition, "inference.lua": inference } }
}

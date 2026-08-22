import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { ActivePackageMetadata } from "../../src/type-system/host"
import { scenarioSnapshot, type SemanticModelScenario } from "../../src/type-system/graph/model-scenario"

const repositoryRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)))
const modelRoot = resolve(repositoryRoot, "front-end/tests/differential/models")
const outputRoot = resolve(repositoryRoot, "examples/diagrams/package")
const models = ["transformer.json", "variational-autoencoder.json", "resnet-product.json"] as const

const packageIds = new Set<string>()
const scenarios: SemanticModelScenario[] = []
for (const file of models) {
  const scenario = await Bun.file(resolve(modelRoot, file)).json() as SemanticModelScenario
  scenarios.push(scenario)
  for (const node of scenario.nodes) packageIds.add(node.packageId)
}
const packages: ActivePackageMetadata[] = []
for (const id of packageIds) {
  const directory = resolve(repositoryRoot, "stereotype-packages/core", id.slice("core.".length))
  const manifest = await Bun.file(resolve(directory, "manifest.json")).json() as { id: string; version: string }
  const definition = await Bun.file(resolve(directory, "stereotype.json")).json() as ActivePackageMetadata["definition"]
  packages.push({ id: manifest.id, version: manifest.version, definition })
}
await mkdir(outputRoot, { recursive: true })
for (const [index, file] of models.entries()) {
  const snapshot = scenarioSnapshot(scenarios[index]!, packages)
  const output = file === "resnet-product.json" ? "resnet.json" : file
  await Bun.write(resolve(outputRoot, output), `${JSON.stringify(snapshot, null, 2)}\n`)
}

import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { TypeSystemHost } from "../../src/type-system/host"
import type { PackageKind } from "../../src/type-system/packages/types"
import type { TypeContext } from "../../src/type-system/type-inference"
import { PROTOCOL_VERSION, parseRequest, type InputInferenceRequest, type ModelInferenceRequest, type ProtocolOutcome, type ProtocolRequest, type ProtocolResponse, type TensorType } from "./protocol"

const repositoryRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)))
const packageRoot = resolve(repositoryRoot, "stereotype-packages/core")
type Definition = { readonly kind: PackageKind }

async function packageSelections(packageIds: readonly string[]) {
  const selections = []
  const definitions = new Map<string, Definition>()
  for (const packageId of packageIds) {
    const directory = resolve(packageRoot, packageId.slice("core.".length))
    const resources = {
      "manifest.json": await Bun.file(resolve(directory, "manifest.json")).text(),
      "stereotype.json": await Bun.file(resolve(directory, "stereotype.json")).text(),
      "inference.lua": await Bun.file(resolve(directory, "inference.lua")).text(),
    }
    definitions.set(packageId, JSON.parse(resources["stereotype.json"]) as Definition)
    selections.push({ directory, resources })
  }
  return { selections, definitions }
}

async function main(): Promise<void> {
  let request: ProtocolRequest | undefined
  let outcome: ProtocolOutcome
  let host: TypeSystemHost | undefined
  try {
    request = parseRequest(JSON.parse(await Bun.stdin.text()))
    const packageIds = request.protocolVersion === 1 ? ["core.input"] : request.packages
    const { selections, definitions } = await packageSelections(packageIds)
    host = await TypeSystemHost.create(selections)
    for (const packageId of packageIds) await host.activate(packageId)
    outcome = request.protocolVersion === 1
      ? inferLegacy(host, request)
      : inferGraph(host, definitions, request)
  } catch (cause) {
    outcome = { status: "fault", message: cause instanceof Error ? cause.message : String(cause) }
  } finally {
    await host?.dispose()
  }
  const response: ProtocolResponse = {
    protocolVersion: PROTOCOL_VERSION,
    implementation: "candidate",
    ...(request?.protocolVersion === 2 ? { modelId: request.modelId } : {}),
    outcome,
  }
  process.stdout.write(JSON.stringify(response))
}

function inferLegacy(host: TypeSystemHost, request: InputInferenceRequest): ProtocolOutcome {
  const result = host.inferForEditor(request.packageId, request.context, request.parameters)
  if (result.status === "fault") return { status: "fault", message: result.fault.message }
  if (result.status === "unresolved") return result
  return result
}

function inferGraph(host: TypeSystemHost, definitions: ReadonlyMap<string, Definition>, request: ModelInferenceRequest): ProtocolOutcome {
  const outputs = new Map<string, TensorType>()
  for (const node of request.nodes) {
    const definition = definitions.get(node.packageId)
    if (!definition) return { status: "error", message: `package '${node.packageId}' is not selected` }
    const inputs: TensorType[] = []
    for (const inputId of node.inputs) {
      const input = outputs.get(inputId)
      if (!input) return { status: "error", message: `node '${node.id}' is evaluated before input '${inputId}'` }
      inputs.push(input)
    }
    const result = host.inferForEditor(node.packageId, typeContext(definition.kind, inputs), node.parameters)
    if (result.status === "success") outputs.set(node.id, result.output)
    else if (result.status === "error") return result
    else if (result.status === "fault") return { status: "fault", message: result.fault.message }
    else return { status: "error", message: `node '${node.id}' is unresolved: ${result.missingParameters.join(", ")}` }
  }
  const output = outputs.get(request.output)
  return output ? { status: "success", output } : { status: "error", message: `output node '${request.output}' has no result` }
}

function typeContext(kind: PackageKind, inputs: readonly TensorType[]): TypeContext {
  if (kind === "input") return { kind, inputs: [] }
  if (kind === "join") return { kind, inputs: inputs as [TensorType, TensorType, ...TensorType[]] }
  if (kind === "subflow") {
    return { kind, inputs: [inputs[0]!], inferSubflow: () => ({ status: "error", message: "nested subflow is not represented in model protocol v2" }) }
  }
  return { kind, inputs: [inputs[0]!] }
}

await main()

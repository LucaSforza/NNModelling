import { resolve } from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"

import { Context } from "@deepseek-ai/cordis"

import { PROTOCOL_VERSION, parseRequest, type InputInferenceRequest, type ModelInferenceRequest, type ProtocolOutcome, type ProtocolRequest, type ProtocolResponse, type TensorType } from "./protocol"

const repositoryRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)))
const oracleRoot = resolve(process.env.STEREOTYPE_LAB_DIR ?? resolve(repositoryRoot, ".cache/stereotype-lab"))

async function referenceModule<T>(path: string): Promise<T> {
  return await import(pathToFileURL(resolve(oracleRoot, path)).href) as T
}

async function main(): Promise<void> {
  let request: ProtocolRequest | undefined
  let outcome: ProtocolOutcome
  const revision = Bun.spawnSync(["git", "-C", oracleRoot, "rev-parse", "HEAD"]).stdout.toString().trim()
  const context = new Context()
  let leases: { dispose(): Promise<void> }[] = []
  try {
    request = parseRequest(JSON.parse(await Bun.stdin.text()))
    const { PackageCatalog } = await referenceModule<typeof import("../../../.cache/stereotype-lab/src/packages/catalog.ts")>("src/packages/catalog.ts")
    const { PackageRegistry } = await referenceModule<typeof import("../../../.cache/stereotype-lab/src/packages/registry.ts")>("src/packages/registry.ts")
    const { PackageLoader } = await referenceModule<typeof import("../../../.cache/stereotype-lab/src/packages/loader.ts")>("src/packages/loader.ts")
    const { LuaPackageInferenceRuntime } = await referenceModule<typeof import("../../../.cache/stereotype-lab/src/packages/lua-runtime.ts")>("src/packages/lua-runtime.ts")
    const packageIds = request.protocolVersion === 1 ? ["core.input"] : request.packages
    const packageDirectories = packageIds.map(packageId => resolve(oracleRoot, "packages/core", packageId.slice("core.".length)))
    const catalog = await PackageCatalog.create(packageDirectories)
    const loader = new PackageLoader(context, catalog, new PackageRegistry(), new LuaPackageInferenceRuntime())
    for (const packageId of packageIds) leases.push(await loader.load(packageId))
    if (request.protocolVersion === 1) {
      const result = loader.infer(request.packageId, request.context, request.parameters)
      outcome = result
    } else {
      const definitions = new Map(request.packages.map(packageId => [packageId, catalog.get(packageId)!.definition]))
      outcome = inferGraph(loader, definitions, request)
    }
  } catch (cause) {
    outcome = { status: "fault", message: cause instanceof Error ? cause.message : String(cause) }
  } finally {
    for (const lease of [...leases].reverse()) await lease.dispose()
    await context.fiber.dispose()
  }
  const response: ProtocolResponse = {
    protocolVersion: PROTOCOL_VERSION,
    implementation: "oracle",
    ...(request?.protocolVersion === 2 ? { modelId: request.modelId } : {}),
    revision,
    outcome,
  }
  process.stdout.write(JSON.stringify(response))
}

function inferGraph(loader: any, definitions: ReadonlyMap<string, { readonly kind: string }>, request: ModelInferenceRequest): ProtocolOutcome {
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
    let result: ProtocolOutcome
    try {
      result = loader.infer(node.packageId, oracleContext(definition.kind, inputs), node.parameters)
    } catch (cause) {
      return { status: "fault", message: cause instanceof Error ? cause.message : String(cause) }
    }
    if (result.status === "success") outputs.set(node.id, result.output)
    else return result
  }
  const output = outputs.get(request.output)
  return output ? { status: "success", output } : { status: "error", message: `output node '${request.output}' has no result` }
}

function oracleContext(kind: string, inputs: readonly TensorType[]): Record<string, unknown> {
  if (kind === "input") return { kind, inputs: [] }
  if (kind === "join") return { kind, inputs }
  if (kind === "subflow") return { kind, inputs: [inputs[0]], inferSubflow: () => ({ status: "error", message: "nested subflow is not represented in model protocol v2" }) }
  return { kind, inputs: [inputs[0]] }
}

await main()

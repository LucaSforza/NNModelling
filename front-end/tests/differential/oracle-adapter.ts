import { resolve } from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import { Context } from "@deepseek-ai/cordis"

import { PROTOCOL_VERSION, parseRequest, type ProtocolOutcome, type ProtocolResponse } from "./protocol"

const repositoryRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)))
const oracleRoot = resolve(process.env.STEREOTYPE_LAB_DIR ?? resolve(repositoryRoot, ".cache/stereotype-lab"))

async function referenceModule<T>(path: string): Promise<T> {
  return await import(pathToFileURL(resolve(oracleRoot, path)).href) as T
}

async function main(): Promise<void> {
  const revision = Bun.spawnSync(["git", "-C", oracleRoot, "rev-parse", "HEAD"]).stdout.toString().trim()
  let outcome: ProtocolOutcome
  const context = new Context()
  let lease: { dispose(): Promise<void> } | undefined
  try {
    const request = parseRequest(JSON.parse(await Bun.stdin.text()))
    const { PackageCatalog } = await referenceModule<typeof import("../../../.cache/stereotype-lab/src/packages/catalog.ts")>("src/packages/catalog.ts")
    const { PackageRegistry } = await referenceModule<typeof import("../../../.cache/stereotype-lab/src/packages/registry.ts")>("src/packages/registry.ts")
    const { PackageLoader } = await referenceModule<typeof import("../../../.cache/stereotype-lab/src/packages/loader.ts")>("src/packages/loader.ts")
    const { LuaPackageInferenceRuntime } = await referenceModule<typeof import("../../../.cache/stereotype-lab/src/packages/lua-runtime.ts")>("src/packages/lua-runtime.ts")
    const packageRoot = resolve(oracleRoot, "packages/core/input")
    const loader = new PackageLoader(context, await PackageCatalog.create([packageRoot]), new PackageRegistry(), new LuaPackageInferenceRuntime())
    lease = await loader.load(request.packageId)
    outcome = loader.infer(request.packageId, request.context, request.parameters)
  } catch (cause) {
    outcome = { status: "fault", message: cause instanceof Error ? cause.message : String(cause) }
  } finally {
    await lease?.dispose()
    await context.fiber.dispose()
  }
  const response: ProtocolResponse = {
    protocolVersion: PROTOCOL_VERSION,
    implementation: "oracle",
    revision,
    outcome,
  }
  process.stdout.write(JSON.stringify(response))
}

await main()

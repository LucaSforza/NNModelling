import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { TypeSystemHost } from "../../src/type-system/host"
import { PROTOCOL_VERSION, parseRequest, type ProtocolOutcome, type ProtocolResponse } from "./protocol"

const repositoryRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)))
const packageRoot = resolve(repositoryRoot, "stereotype-packages/core/input")

async function main(): Promise<void> {
  let outcome: ProtocolOutcome
  let host: TypeSystemHost | undefined
  try {
    const request = parseRequest(JSON.parse(await Bun.stdin.text()))
    host = await TypeSystemHost.create([{
      directory: packageRoot,
      resources: {
        "manifest.json": await Bun.file(resolve(packageRoot, "manifest.json")).text(),
        "stereotype.json": await Bun.file(resolve(packageRoot, "stereotype.json")).text(),
        "inference.lua": await Bun.file(resolve(packageRoot, "inference.lua")).text(),
      },
    }])
    await host.activate(request.packageId)
    const result = host.inferForEditor(request.packageId, request.context, request.parameters)
    outcome = result.status === "fault"
      ? { status: "fault", message: result.fault.message }
      : result
  } catch (cause) {
    outcome = { status: "fault", message: cause instanceof Error ? cause.message : String(cause) }
  } finally {
    await host?.dispose()
  }
  const response: ProtocolResponse = { protocolVersion: PROTOCOL_VERSION, implementation: "candidate", outcome }
  process.stdout.write(JSON.stringify(response))
}

await main()

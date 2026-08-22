import type { PackageResourceMap, PackageResourceProvider } from "./types"

/** Resolve a package-relative entrypoint without filesystem APIs or traversal. */
export function resolvePackageFile(directoryOrEntrypoint: string, maybeEntrypoint?: string): string {
  const entrypoint = maybeEntrypoint ?? directoryOrEntrypoint
  if (!entrypoint || entrypoint.startsWith("/") || entrypoint.includes("\\") || entrypoint.split("/").includes("..")) {
    throw new Error("entrypoint must stay within package")
  }
  return entrypoint
}

export function resourceText(resources: PackageResourceProvider | PackageResourceMap, entrypoint: string): Promise<string> {
  const path = resolvePackageFile(entrypoint)
  if (typeof resources === "object" && "read" in resources && typeof resources.read === "function") {
    return Promise.resolve(resources.read(path)).then(decodeResource)
  }
  const value = (resources as PackageResourceMap)[path]
  if (value === undefined) return Promise.reject(new Error(`package resource '${path}' is missing`))
  return Promise.resolve(decodeResource(value))
}

export async function readJson(resources: PackageResourceProvider | PackageResourceMap, entrypoint: string): Promise<unknown> {
  try { return JSON.parse(await resourceText(resources, entrypoint)) }
  catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`invalid JSON in ${entrypoint}: ${message}`)
  }
}

function decodeResource(value: string | Uint8Array): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value)
}

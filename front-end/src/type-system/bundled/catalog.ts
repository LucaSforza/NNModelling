import type { PackageSelection } from "../host"

const manifests = import.meta.glob("../../../../stereotype-packages/core/*/manifest.json", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>
const definitions = import.meta.glob("../../../../stereotype-packages/core/*/stereotype.json", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>
const inferenceRules = import.meta.glob("../../../../stereotype-packages/core/*/inference.lua", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>

/** Discover bundled product packages by directory convention, without package-ID cases. */
export function bundledCorePackages(): PackageSelection[] {
  return Object.entries(manifests).map(([manifestPath, manifest]) => {
    const directory = manifestPath.slice(0, -"/manifest.json".length)
    const definition = definitions[`${directory}/stereotype.json`]
    const inference = inferenceRules[`${directory}/inference.lua`]
    if (definition === undefined || inference === undefined) {
      throw new Error(`bundled package '${directory}' is incomplete`)
    }
    return {
      directory,
      resources: {
        "manifest.json": manifest,
        "stereotype.json": definition,
        "inference.lua": inference,
      },
    }
  })
}

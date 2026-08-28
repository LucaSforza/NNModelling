import { LuaInferenceRuntime } from "../lua/lua-inference-runtime"
import { resourceText } from "./path"
import type { InferenceRuntime, LoadedInferenceRule, Package, StereotypeReference } from "./types"

/** Package runtime adapter: resources are delivered by the browser bundle seam. */
export class LuaPackageInferenceRuntime implements InferenceRuntime {
  async load(packageInfo: Package, inferenceFile: string): Promise<LoadedInferenceRule> {
    const identity = `${packageInfo.manifest.id}@${packageInfo.manifest.version}`
    let runtime: LuaInferenceRuntime
    try {
      runtime = await LuaInferenceRuntime.create(await resourceText(packageInfo.resources, inferenceFile))
    } catch (cause) {
      throw fault(identity, inferenceFile, cause)
    }

    return {
      infer: (context, parameters, services) => {
        try {
          return runtime.inferType(context, parameters, {
            inferSubflow: services.inferSubflow,
            ...(services.inferStereotype ? {
              inferStereotype: (reference, inputs) => isReference(reference)
                ? services.inferStereotype!(reference, inputs)
                : { status: "error", message: "invalid stereotype reference" },
            } : {}),
          })
        } catch (cause) {
          // Preserve the thrown outcome as a fault; PackageLoader intentionally
          // does not flatten this into an expected TypeResult error.
          throw fault(identity, inferenceFile, cause)
        }
      },
      dispose: () => runtime.dispose(),
    }
  }
}

function isReference(value: unknown): value is StereotypeReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const reference = value as { id?: unknown; version?: unknown; parameters?: unknown }
  return typeof reference.id === "string" && typeof reference.version === "string" &&
    !!reference.parameters && typeof reference.parameters === "object" && !Array.isArray(reference.parameters)
}

function fault(identity: string, file: string, cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause)
  return new Error(`${identity} (${file}): ${message}`, { cause })
}

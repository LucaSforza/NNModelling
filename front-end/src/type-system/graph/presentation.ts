import type { GraphInferenceResult } from "./types"

export function packageOutputLabel(result: GraphInferenceResult | null, nodeId: string): string | null {
  const state = result?.nodes.get(nodeId)
  if (state?.status !== "success") return null
  return `[${state.output.shape.join(",")}] ${state.output.dtype}`
}

export function packageDiagnostic(
  result: GraphInferenceResult | null,
  nodeId: string,
): { severity: "error" | "warning"; message: string } | null {
  const state = result?.nodes.get(nodeId)
  if (!state || state.status === "success") return null
  if (state.status === "error") return { severity: "error", message: state.message }
  if (state.status === "fault") return { severity: "error", message: state.fault.message }
  if ("missingParameters" in state) {
    return { severity: "warning", message: `Missing: ${state.missingParameters.join(", ")}` }
  }
  return { severity: "warning", message: state.reason }
}

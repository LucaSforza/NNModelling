import type { TensorType } from "../../src/type-system/tensor-type"

export const PROTOCOL_VERSION = 1 as const

export type InputInferenceRequest = {
  readonly protocolVersion: typeof PROTOCOL_VERSION
  readonly operation: "infer"
  readonly packageId: "core.input"
  readonly context: { readonly kind: "input"; readonly inputs: readonly [] }
  readonly parameters: Readonly<Record<string, unknown>>
}

export type ProtocolOutcome =
  | { readonly status: "success"; readonly output: TensorType }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "unresolved"; readonly missingParameters: readonly string[] }
  | { readonly status: "fault"; readonly message: string }

export type ProtocolResponse = {
  readonly protocolVersion: typeof PROTOCOL_VERSION
  readonly implementation: "candidate" | "oracle"
  readonly revision?: string
  readonly outcome: ProtocolOutcome
}

export function parseRequest(value: unknown): InputInferenceRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request must be an object")
  const request = value as Partial<InputInferenceRequest>
  if (request.protocolVersion !== PROTOCOL_VERSION) throw new Error(`unsupported protocol version '${String(request.protocolVersion)}'`)
  if (request.operation !== "infer" || request.packageId !== "core.input") throw new Error("unsupported T01 operation")
  if (request.context?.kind !== "input" || !Array.isArray(request.context.inputs) || request.context.inputs.length !== 0) {
    throw new Error("core.input requires an empty input context")
  }
  if (!request.parameters || typeof request.parameters !== "object" || Array.isArray(request.parameters)) {
    throw new Error("parameters must be an object")
  }
  return request as InputInferenceRequest
}

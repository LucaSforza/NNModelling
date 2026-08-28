export const PROTOCOL_VERSION = 2 as const

export type Dimension = string | number
export type DType =
  | "float16" | "bfloat16" | "float32" | "float64"
  | "int8" | "uint8" | "int16" | "int32" | "int64" | "bool"

export type TensorType = {
  readonly shape: readonly Dimension[]
  readonly dtype: DType
}

export type ModelId = "transformer" | "variational-autoencoder" | "resnet"

export type ModelNode = {
  readonly id: string
  readonly packageId: string
  readonly parameters: Readonly<Record<string, unknown>>
  readonly inputs: readonly string[]
}

/** Minimal semantic graph wire format; it intentionally excludes editor/NNTree state. */
export type ModelInferenceRequest = {
  readonly protocolVersion: typeof PROTOCOL_VERSION
  readonly operation: "infer-model"
  readonly modelId: ModelId
  readonly packages: readonly string[]
  readonly nodes: readonly ModelNode[]
  readonly output: string
}

/** Kept for the T01 regression while model protocol v2 is introduced. */
export type InputInferenceRequest = {
  readonly protocolVersion: 1
  readonly operation: "infer"
  readonly packageId: "core.input"
  readonly context: { readonly kind: "input"; readonly inputs: readonly [] }
  readonly parameters: Readonly<Record<string, unknown>>
}

export type ProtocolRequest = ModelInferenceRequest | InputInferenceRequest

export type ProtocolOutcome =
  | { readonly status: "success"; readonly output: TensorType }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "unresolved"; readonly missingParameters: readonly string[] }
  | { readonly status: "fault"; readonly message: string }

export type ProtocolResponse = {
  readonly protocolVersion: 1 | typeof PROTOCOL_VERSION
  readonly implementation: "candidate" | "oracle"
  readonly modelId?: ModelId
  readonly revision?: string
  readonly outcome: ProtocolOutcome
}

export function parseRequest(value: unknown): ProtocolRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request must be an object")
  const request = value as Partial<ModelInferenceRequest>
  if (request.protocolVersion === 1) {
    const legacy = value as Partial<InputInferenceRequest>
    if (legacy.operation !== "infer" || legacy.packageId !== "core.input") throw new Error("unsupported legacy operation")
    if (legacy.context?.kind !== "input" || !Array.isArray(legacy.context.inputs) || legacy.context.inputs.length !== 0) {
      throw new Error("core.input requires an empty input context")
    }
    if (!legacy.parameters || typeof legacy.parameters !== "object" || Array.isArray(legacy.parameters)) throw new Error("parameters must be an object")
    return legacy as InputInferenceRequest
  }
  if (request.protocolVersion !== PROTOCOL_VERSION) throw new Error(`unsupported protocol version '${String(request.protocolVersion)}'`)
  if (request.operation !== "infer-model") throw new Error("unsupported model operation")
  if (!isModelId(request.modelId)) throw new Error("unsupported model id")
  if (!Array.isArray(request.packages) || request.packages.some(packageId => typeof packageId !== "string")) {
    throw new Error("packages must be an array of package ids")
  }
  if (!Array.isArray(request.nodes) || request.nodes.length === 0) throw new Error("nodes must be non-empty")
  if (typeof request.output !== "string") throw new Error("output must be a node id")

  const ids = new Set<string>()
  for (const node of request.nodes) {
    if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error("node must be an object")
    if (typeof node.id !== "string" || ids.has(node.id)) throw new Error(`invalid or duplicate node id '${String(node.id)}'`)
    ids.add(node.id)
    if (typeof node.packageId !== "string" || !request.packages.includes(node.packageId)) {
      throw new Error(`node '${node.id}' references an unselected package`)
    }
    if (!node.parameters || typeof node.parameters !== "object" || Array.isArray(node.parameters)) {
      throw new Error(`node '${node.id}' parameters must be an object`)
    }
    if (!Array.isArray(node.inputs) || node.inputs.some(input => typeof input !== "string")) {
      throw new Error(`node '${node.id}' inputs must be an array of node ids`)
    }
  }
  if (!ids.has(request.output)) throw new Error(`output node '${request.output}' is missing`)
  for (const node of request.nodes) {
    for (const input of node.inputs) if (!ids.has(input)) throw new Error(`node '${node.id}' references missing input '${input}'`)
  }
  return request as ModelInferenceRequest
}

function isModelId(value: unknown): value is ModelId {
  return value === "transformer" || value === "variational-autoencoder" || value === "resnet"
}

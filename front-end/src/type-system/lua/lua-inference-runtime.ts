import { LuaFactory, LuaMultiReturn } from "wasmoon"

import { isDType, type TensorType } from "../tensor-type"
import type { TypeResult } from "../type-inference"

export type LuaInferenceContext = {
  readonly inputs: readonly TensorType[]
}

export type LuaInferenceServices = {
  readonly inferSubflow?: (input: TensorType) => TypeResult
  readonly inferStereotype?: (
    reference: unknown,
    inputs: readonly TensorType[],
  ) => TypeResult
}

export type LuaInferenceLimits = {
  readonly executionMs: number
  readonly memoryBytes: number
}

const defaultLimits: LuaInferenceLimits = {
  executionMs: 25,
  memoryBytes: 1024 * 1024,
}

const factory = new LuaFactory()

type LuaFunction = (
  context: LuaInferenceContext,
  parameters: Readonly<Record<string, unknown>>,
  services: LuaInferenceServices,
) => unknown

/** One isolated Lua state owned by one active stereotype package. */
export class LuaInferenceRuntime {
  private disposed = false

  private constructor(
    private readonly engine: Awaited<ReturnType<typeof factory.createEngine>>,
    private readonly createInfer: () => unknown,
  ) {}

  static async create(
    source: string,
    limits: Partial<LuaInferenceLimits> = {},
  ): Promise<LuaInferenceRuntime> {
    const resolvedLimits = { ...defaultLimits, ...limits }
    validateLimits(resolvedLimits)

    const engine = await factory.createEngine({
      enableProxy: false,
      functionTimeout: resolvedLimits.executionMs,
      injectObjects: false,
      openStandardLibs: true,
      traceAllocations: true,
    })
    engine.global.setMemoryMax(resolvedLimits.memoryBytes)

    try {
      engine.global.set("__host_tensor_rank", tensorRank)
      engine.global.set("__host_tensor_create", tensorCreate)
      engine.global.set("__host_tensor_dimension", tensorDimension)
      engine.global.set("__host_tensor_with_dimension", tensorWithDimension)
      engine.global.set("__host_tensor_append_dimension", tensorAppendDimension)
      engine.global.set("__host_tensor_flatten", tensorFlatten)
      engine.global.set("__host_tensor_dtype", tensorDType)
      engine.global.set("__host_tensor_with_dtype", tensorWithDType)
      engine.global.set("__host_tensor_equal", tensorEqual)

      // Calling a Lua function applies Wasmoon's instruction-hook deadline.
      const load = engine.doStringSync(buildLoader(source)) as () => unknown
      const entrypoint = load()

      if (typeof entrypoint !== "function") {
        throw new Error("inference.lua must return exactly one function")
      }

      return new LuaInferenceRuntime(engine, load)
    } catch (error) {
      engine.global.close()
      throw scriptFault("activation", error)
    }
  }

  inferType(
    context: LuaInferenceContext,
    parameters: Readonly<Record<string, unknown>>,
    services: LuaInferenceServices = {},
  ): TypeResult {
    this.assertActive()

    try {
      // Recreate only the closure, not the compiled script or Lua state. This
      // prevents mutable upvalues from making inference order-dependent.
      const infer = this.createInfer()
      if (typeof infer !== "function") throw new Error("inference.lua no longer returns a function")
      const result = (infer as LuaFunction)(
        copyContext(context),
        structuredClone(parameters),
        createServices(services),
      )
      return validateResult(result)
    } catch (error) {
      throw scriptFault("inference", error)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.engine.global.close()
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error("Lua inference runtime has been disposed")
    }
  }
}

function buildLoader(source: string): string {
  return `return function()
  local host_rank = __host_tensor_rank
  local host_create = __host_tensor_create
  local host_dimension = __host_tensor_dimension
  local host_with_dimension = __host_tensor_with_dimension
  local host_append_dimension = __host_tensor_append_dimension
  local host_flatten = __host_tensor_flatten
  local host_dtype = __host_tensor_dtype
  local host_with_dtype = __host_tensor_with_dtype
  local host_equal = __host_tensor_equal
  local tensor_library = {
    create = host_create,
    rank = host_rank,
    dimension = host_dimension,
    with_dimension = host_with_dimension,
    append_dimension = host_append_dimension,
    flatten = host_flatten,
    dtype = host_dtype,
    with_dtype = host_with_dtype,
    equal = host_equal,
  }
  local safe_math = {
    abs = math.abs, ceil = math.ceil, floor = math.floor,
    max = math.max, min = math.min, sqrt = math.sqrt,
    huge = math.huge, pi = math.pi,
  }
  local safe_string = {
    byte = string.byte, char = string.char, find = string.find,
    format = string.format, gmatch = string.gmatch, gsub = string.gsub,
    len = string.len, lower = string.lower, match = string.match,
    rep = string.rep, reverse = string.reverse, sub = string.sub,
    upper = string.upper,
  }
  local safe_table = {
    concat = table.concat, insert = table.insert, move = table.move,
    pack = table.pack, remove = table.remove, sort = table.sort,
    unpack = table.unpack,
  }
  local allowed = {
    assert = assert, error = error, ipairs = ipairs, pairs = pairs,
    select = select, tonumber = tonumber, tostring = tostring, type = type,
    math = safe_math, string = safe_string, table = safe_table, tensor = tensor_library,
  }
  local environment = setmetatable({}, {
    __index = allowed,
    __newindex = function(_, name) error("global assignment is not allowed: " .. tostring(name)) end,
    __metatable = false,
  })
  local _ENV = environment
${source}
end`
}

function createServices(services: LuaInferenceServices): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  if (services.inferSubflow) {
    result.infer_subflow = (input: unknown) => {
      return services.inferSubflow!(copyTensor(input))
    }
  }

  if (services.inferStereotype) {
    result.infer_stereotype = (reference: unknown, inputs: unknown) => {
      return services.inferStereotype!(
        structuredClone(reference),
        copyTensorSequence(inputs),
      )
    }
  }

  return result
}

function copyContext(context: LuaInferenceContext): LuaInferenceContext {
  return { inputs: context.inputs.map(copyTensor) }
}

function tensorCreate(shape: unknown, dtype: unknown): TensorType | LuaMultiReturn {
  const dimensions = luaSequence(shape)
  if (!dimensions || !dimensions.every(isDimension)) {
    return failure("tensor shape must contain only finite numbers or strings")
  }
  if (!isDType(dtype)) return failure("tensor dtype is unsupported")
  return { shape: [...dimensions], dtype }
}

function tensorRank(value: unknown): number | LuaMultiReturn {
  const tensor = tensorOrError(value)
  return tensor instanceof Error
    ? failure(tensor.message)
    : tensor.shape.length
}

function tensorDimension(value: unknown, dim: unknown): unknown {
  const tensor = tensorOrError(value)
  if (tensor instanceof Error) return failure(tensor.message)
  const index = dimensionIndex(tensor, dim)
  return index instanceof Error ? failure(index.message) : tensor.shape[index]
}

function tensorWithDimension(value: unknown, dim: unknown, size: unknown): unknown {
  const tensor = tensorOrError(value)
  if (tensor instanceof Error) return failure(tensor.message)
  const index = dimensionIndex(tensor, dim)
  if (index instanceof Error) return failure(index.message)
  if (!isDimension(size)) return failure("tensor dimension must be a finite number or string")

  const shape = [...tensor.shape]
  shape[index] = size
  return { shape, dtype: tensor.dtype }
}

function tensorAppendDimension(value: unknown, size: unknown): unknown {
  const tensor = tensorOrError(value)
  if (tensor instanceof Error) return failure(tensor.message)
  if (!isDimension(size)) return failure("tensor dimension must be a finite number or string")
  return { shape: [...tensor.shape, size], dtype: tensor.dtype }
}

function tensorFlatten(value: unknown, start: unknown, end: unknown): unknown {
  const tensor = tensorOrError(value)
  if (tensor instanceof Error) return failure(tensor.message)
  const startIndex = dimensionIndex(tensor, start)
  if (startIndex instanceof Error) return failure(startIndex.message)
  const endIndex = dimensionIndex(tensor, end)
  if (endIndex instanceof Error) return failure(endIndex.message)
  if (startIndex > endIndex) return failure("flatten start dimension must not exceed end dimension")
  if (startIndex === endIndex) return { shape: [...tensor.shape], dtype: tensor.dtype }

  let product = 1
  for (let index = startIndex; index <= endIndex; index++) {
    const dimension = tensor.shape[index]
    if (typeof dimension !== "number") return failure("flatten requires numeric dimensions")
    product *= dimension
  }
  return {
    shape: [
      ...tensor.shape.slice(0, startIndex),
      product,
      ...tensor.shape.slice(endIndex + 1),
    ],
    dtype: tensor.dtype,
  }
}

function tensorDType(value: unknown): unknown {
  const tensor = tensorOrError(value)
  return tensor instanceof Error ? failure(tensor.message) : tensor.dtype
}

function tensorWithDType(value: unknown, dtype: unknown): unknown {
  const tensor = tensorOrError(value)
  if (tensor instanceof Error) return failure(tensor.message)
  if (!isDType(dtype)) return failure("tensor dtype is unsupported")
  return { shape: [...tensor.shape], dtype }
}

function tensorEqual(left: unknown, right: unknown): boolean | LuaMultiReturn {
  const leftTensor = tensorOrError(left)
  if (leftTensor instanceof Error) return failure(leftTensor.message)
  const rightTensor = tensorOrError(right)
  if (rightTensor instanceof Error) return failure(rightTensor.message)
  return leftTensor.dtype === rightTensor.dtype &&
    leftTensor.shape.length === rightTensor.shape.length &&
    leftTensor.shape.every((dimension, index) => dimension === rightTensor.shape[index])
}

function failure(message: string): LuaMultiReturn {
  const values = new LuaMultiReturn()
  values.push(undefined, message)
  return values
}

function dimensionIndex(tensor: TensorType, dim: unknown): number | Error {
  if (!Number.isInteger(dim)) return new Error("tensor dimension index must be an integer")
  const dimension = dim as number
  const index = dimension < 0 ? tensor.shape.length + dimension : dimension
  return index < 0 || index >= tensor.shape.length
    ? new Error(`tensor dimension ${dimension} is out of range`)
    : index
}

function copyTensor(value: unknown): TensorType {
  const tensor = tensorOrError(value)
  if (tensor instanceof Error) throw tensor
  return { shape: [...tensor.shape], dtype: tensor.dtype }
}

function copyTensorSequence(value: unknown): readonly TensorType[] {
  if (!Array.isArray(value)) throw new Error("inputs must be a tensor sequence")
  return value.map(copyTensor)
}

function tensorOrError(value: unknown): TensorType | Error {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return new Error("expected tensor type")
  }
  const shape = luaSequence((value as { shape?: unknown }).shape)
  const dtype = (value as { dtype?: unknown }).dtype
  if (!shape || !shape.every(isDimension)) {
    return new Error("tensor type must contain a shape of finite numbers or strings")
  }
  if (!isDType(dtype)) return new Error("tensor type must contain a supported dtype")
  return { shape: [...shape], dtype }
}

function luaSequence(value: unknown): readonly unknown[] | undefined {
  if (Array.isArray(value)) return value
  // Wasmoon represents an empty Lua sequence as an empty object when it
  // crosses back into JavaScript. No other object shape is a valid sequence.
  if (value && typeof value === "object" && Object.keys(value).length === 0) return []
  return undefined
}

function isDimension(value: unknown): value is string | number {
  return typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
}

function validateResult(value: unknown): TypeResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("inference result must be a table")
  }
  const result = value as { status?: unknown; output?: unknown; message?: unknown }
  if (result.status === "success") return { status: "success", output: copyTensor(result.output) }
  if (result.status === "error" && typeof result.message === "string") {
    return { status: "error", message: result.message }
  }
  throw new Error("invalid inference result")
}

function validateLimits(limits: LuaInferenceLimits): void {
  if (!Number.isFinite(limits.executionMs) || limits.executionMs <= 0) {
    throw new Error("executionMs must be a positive finite number")
  }
  if (!Number.isInteger(limits.memoryBytes) || limits.memoryBytes < 64 * 1024) {
    throw new Error("memoryBytes must be an integer of at least 65536")
  }
}

function scriptFault(phase: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`Lua ${phase} fault: ${message}`)
}

/** Semantic tensor values shared by package inference and the editor adapter. */
export type Dimension = string | number

export const DTYPES = [
  "float16",
  "bfloat16",
  "float32",
  "float64",
  "int8",
  "uint8",
  "int16",
  "int32",
  "int64",
  "bool",
] as const

export type DType = typeof DTYPES[number]

export type TensorType = {
  readonly shape: readonly Dimension[]
  readonly dtype: DType
}

export function isDType(value: unknown): value is DType {
  return typeof value === "string" && (DTYPES as readonly string[]).includes(value)
}

export function isDimension(value: unknown): value is Dimension {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
}

export function isTensorType(value: unknown): value is TensorType {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const candidate = value as { shape?: unknown; dtype?: unknown }
  return Array.isArray(candidate.shape) && candidate.shape.every(isDimension) && isDType(candidate.dtype)
}

export function equalTensorTypes(left: TensorType, right: TensorType): boolean {
  return left.dtype === right.dtype &&
    left.shape.length === right.shape.length &&
    left.shape.every((dimension, index) => dimension === right.shape[index])
}

export function copyTensorType(value: TensorType): TensorType {
  return { shape: [...value.shape], dtype: value.dtype }
}

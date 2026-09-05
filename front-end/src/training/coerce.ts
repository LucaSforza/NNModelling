export type TrainingDraftValue = string | number | boolean | undefined

/** Convert a form value according to the dataset contract's canonical types. */
export function coerceTrainingValue(value: string, type: string): TrainingDraftValue {
  const normalized = type.toLowerCase()
  if (normalized === "string" || normalized === "str") return value
  if (!value.trim()) return undefined
  if (normalized === "integer" || normalized === "int") {
    const number = Number(value)
    if (!Number.isInteger(number)) throw new Error("Inserisci un numero intero valido")
    return number
  }
  if (normalized === "number" || normalized === "float") {
    const number = Number(value)
    if (!Number.isFinite(number)) throw new Error("Inserisci un numero valido")
    return number
  }
  if (normalized === "boolean" || normalized === "bool") {
    if (value === "true") return true
    if (value === "false") return false
    throw new Error("Inserisci true oppure false")
  }
  return value
}

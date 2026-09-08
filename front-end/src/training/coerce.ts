export type TrainingDraftValue = string | number | boolean | undefined

/** Convert a form value according to the dataset contract's canonical types. */
export function coerceTrainingValue(value: string | number | boolean | undefined, type: string): TrainingDraftValue {
  const normalized = type.toLowerCase()
  if (normalized === "string" || normalized === "str") return value === undefined ? "" : String(value)
  if (typeof value === "boolean") {
    if (normalized === "boolean" || normalized === "bool") return value
    throw new Error("Inserisci un valore numerico valido")
  }
  const text = value === undefined ? "" : String(value)
  if (!text.trim()) return undefined
  if (normalized === "integer" || normalized === "int") {
    const number = Number(text)
    if (!Number.isInteger(number)) throw new Error("Inserisci un numero intero valido")
    return number
  }
  if (normalized === "number" || normalized === "float") {
    const number = Number(text)
    if (!Number.isFinite(number)) throw new Error("Inserisci un numero valido")
    return number
  }
  if (normalized === "boolean" || normalized === "bool") {
    if (text === "true") return true
    if (text === "false") return false
    throw new Error("Inserisci true oppure false")
  }
  return typeof value === "number" ? text : value
}

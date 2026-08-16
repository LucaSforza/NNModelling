import { equalDimensions, formatDimension, type DimensionValue, type TensorValue } from "../expr";

export type EinsumResult = { readonly ok: true; readonly shape: readonly DimensionValue[] } | { readonly ok: false; readonly message: string };

/** Concrete, label-based einsum shape inference. Ellipsis stays intentionally unsupported. */
export function evaluateEinsumShape(equation: string, inputs: readonly TensorValue[]): EinsumResult {
  const normalized = equation.replace(/\s/g, "");
  if (normalized.includes("...")) return { ok: false, message: "einsum ellipsis is unsupported" };
  const parts = normalized.split("->");
  if (parts.length !== 2 || !parts[0]) return { ok: false, message: "einsum equation requires exactly one '->'" };
  const [left, output] = parts;
  if (!/^[a-zA-Z]*(?:,[a-zA-Z]*)*$/.test(left) || !/^[a-zA-Z]*$/.test(output)) return { ok: false, message: "einsum labels must be alphabetic" };
  const terms = left.split(",");
  if (terms.some((term) => !term)) return { ok: false, message: "einsum input labels cannot be empty" };
  if (terms.length !== inputs.length) return { ok: false, message: `einsum expects ${terms.length} inputs, got ${inputs.length}` };
  const labels = new Map<string, DimensionValue>();
  for (let index = 0; index < terms.length; index += 1) {
    if (terms[index].length !== inputs[index].shape.length) return { ok: false, message: `einsum input ${index + 1} rank does not match '${terms[index]}'` };
    for (let axis = 0; axis < terms[index].length; axis += 1) { const label = terms[index][axis]; const dimension = inputs[index].shape[axis]; const previous = labels.get(label); if (previous !== undefined && !equalDimensions(previous, dimension)) return { ok: false, message: `einsum label '${label}' has incompatible dimensions ${formatDimension(previous)} and ${formatDimension(dimension)}` }; labels.set(label, dimension); }
  }
  if (new Set(output).size !== output.length) return { ok: false, message: "einsum output cannot repeat a label" };
  const shape: DimensionValue[] = [];
  for (const label of output) { const dimension = labels.get(label); if (dimension === undefined) return { ok: false, message: `einsum output label '${label}' is not present in an input` }; shape.push(dimension); }
  return { ok: true, shape };
}

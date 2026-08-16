import type { InputGroup } from "./model";
import type { TensorValue } from "../expr";

export interface AllocatedInputGroup {
  readonly group: InputGroup;
  readonly index: number;
  readonly label: string;
  readonly inputs: readonly TensorValue[];
}

export type InputAllocation =
  | { readonly ok: true; readonly groups: readonly AllocatedInputGroup[] }
  | { readonly ok: false; readonly message: string; readonly group?: number };

/** Allocate left-to-right, giving earlier variable groups their smallest valid share. */
export function allocateInputGroups(groups: readonly InputGroup[], inputs: readonly TensorValue[]): InputAllocation {
  const allocate = (groupIndex: number, inputIndex: number): readonly AllocatedInputGroup[] | undefined => {
    if (groupIndex === groups.length) return inputIndex === inputs.length ? [] : undefined;
    const group = groups[groupIndex];
    const suffixLower = groups.slice(groupIndex + 1).reduce((sum, item) => sum + item.lower, 0);
    const maximum = Math.min(group.upper ?? Number.MAX_SAFE_INTEGER, inputs.length - inputIndex - suffixLower);
    for (let count = group.lower; count <= maximum; count += 1) {
      const rest = allocate(groupIndex + 1, inputIndex + count);
      if (rest) return [{ group, index: groupIndex, label: group.label ?? `input group ${groupIndex + 1}`, inputs: inputs.slice(inputIndex, inputIndex + count) }, ...rest];
    }
    return undefined;
  };
  const allocated = allocate(0, 0);
  return allocated ? { ok: true, groups: allocated } : { ok: false, message: `input count ${inputs.length} does not satisfy declared input groups` };
}

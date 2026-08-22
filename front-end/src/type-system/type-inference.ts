import type { TensorType } from "./tensor-type"

/** Expected semantic outcomes. Host/runtime faults are thrown separately. */
export type TypeResult =
  | { readonly status: "success"; readonly output: TensorType }
  | { readonly status: "error"; readonly message: string }

export type InputTypeContext = { readonly kind: "input"; readonly inputs: readonly [] }
export type LayerTypeContext = { readonly kind: "layer"; readonly inputs: readonly [TensorType] }
export type LossTypeContext = { readonly kind: "loss"; readonly inputs: readonly [TensorType] }
export type JoinTypeContext = { readonly kind: "join"; readonly inputs: readonly [TensorType, TensorType, ...TensorType[]] }
export type SubflowTypeContext = {
  readonly kind: "subflow"
  readonly inputs: readonly [TensorType]
  readonly inferSubflow: (input: TensorType) => TypeResult
}

export type TypeContext = InputTypeContext | LayerTypeContext | LossTypeContext | JoinTypeContext | SubflowTypeContext

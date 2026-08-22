import type { DType, Dimension, TensorType } from "../tensor-type"
import type { TypeContext, TypeResult } from "../type-inference"

export type PackageKind = "input" | "layer" | "loss" | "join" | "subflow"

export type StereotypeReference = {
  readonly id: string
  readonly version: string
  readonly parameters: Readonly<Record<string, unknown>>
}

export type ParameterDefinition =
  | { readonly type: "integer"; readonly minimum?: number; readonly maximum?: number; readonly default?: number; readonly position?: "top" | "bottom" }
  | { readonly type: "number"; readonly minimum?: number; readonly maximum?: number; readonly default?: number; readonly position?: "top" | "bottom" }
  | { readonly type: "boolean"; readonly default?: boolean; readonly position?: "top" | "bottom" }
  | { readonly type: "string"; readonly choices?: readonly string[]; readonly default?: string; readonly position?: "top" | "bottom" }
  | { readonly type: "dtype"; readonly choices: readonly DType[]; readonly default?: DType; readonly position?: "top" | "bottom" }
  | { readonly type: "shape"; readonly default?: readonly Dimension[]; readonly position?: "top" | "bottom" }
  | { readonly type: "list"; readonly items: Exclude<ParameterDefinition, { readonly type: "dtype" } | { readonly type: "shape" } | { readonly type: "list" } | { readonly type: "stereotype" }>; readonly minItems?: number; readonly maxItems?: number; readonly default?: readonly unknown[]; readonly position?: "top" | "bottom" }
  | { readonly type: "stereotype"; readonly kind: PackageKind; readonly default?: StereotypeReference; readonly position?: "top" | "bottom" }

export type Definition = {
  readonly name: string
  readonly description?: string
  readonly kind: PackageKind
  readonly view: { readonly color: string; readonly width: number; readonly height: number }
  readonly parameters: Readonly<Record<string, ParameterDefinition>>
}

export type Manifest = {
  readonly schemaVersion: 1
  readonly id: string
  readonly version: string
  readonly dependencies: Readonly<Record<string, string>>
  readonly entrypoints: {
    readonly definition: string
    readonly inference?: { readonly language: "lua"; readonly file: string }
    readonly pytorch?: { readonly language: "python"; readonly file: string }
  }
}

/** Browser resource seam. It deliberately exposes only package-relative reads. */
export type PackageResourceProvider = {
  readonly read: (path: string) => string | Uint8Array | Promise<string | Uint8Array>
}

export type PackageResourceMap = Readonly<Record<string, string | Uint8Array>>

export type PackageBundle = {
  readonly manifest: Manifest
  readonly definition: Definition
  readonly resources: PackageResourceProvider | PackageResourceMap
  readonly directory?: string
}

export type Package = PackageBundle

export type InferenceServices = {
  readonly inferSubflow?: (input: TensorType) => TypeResult
  readonly inferStereotype?: (reference: StereotypeReference, inputs: readonly TensorType[]) => TypeResult
}

export type InferenceRule = (
  context: TypeContext,
  parameters: Readonly<Record<string, unknown>>,
  services: InferenceServices,
) => TypeResult

export type LoadedInferenceRule = {
  readonly infer: InferenceRule
  readonly dispose: () => void | Promise<void>
}

export type InferenceRuntime = {
  load(packageInfo: Package, inferenceFile: string): Promise<LoadedInferenceRule>
}

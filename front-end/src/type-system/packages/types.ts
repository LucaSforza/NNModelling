import type { DType, Dimension, TensorType } from "../tensor-type"
import type { TypeContext, TypeResult } from "../type-inference"

export type PackageKind = "input" | "layer" | "loss" | "join" | "subflow" | "output"

export type BatchSlotSource = `batch.targets.${string}`

export type ObjectiveExternalInput = {
  readonly name: string
  readonly source: BatchSlotSource
  /** Optional declarative conversion from the dataset target contract. */
  readonly transform?: "flatten_batch"
}

export type ObjectiveDefinition = {
  readonly externalInputs: readonly ObjectiveExternalInput[]
}

/** A value crossing the generic installed-wheel adapter boundary. */
export type WheelAdapterValueSchema =
  | { readonly type: "tensor"; readonly shape: readonly Dimension[]; readonly dtype: DType }
  | { readonly type: "number" }
  | { readonly type: "integer" }
  | { readonly type: "boolean" }
  | { readonly type: "string" }

export type WheelAdapterRandomness =
  | { readonly mode: "none" }
  | { readonly mode: "random" }
  | { readonly mode: "seeded"; readonly seedInput: string }

export type WheelAdapterDefinition = {
  readonly name: string
  /** Stable allowlisted protocol identifier, not an arbitrary Python symbol. */
  readonly entrypoint: string
  readonly input: WheelAdapterValueSchema
  readonly output: WheelAdapterValueSchema
  readonly targetPolicy: "forbidden"
  readonly randomness?: WheelAdapterRandomness
}

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
  readonly objective?: ObjectiveDefinition
  readonly wheelAdapters?: readonly WheelAdapterDefinition[]
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

/** The only persisted package identity. Display names are never part of it. */
export type PackageKey = `${string}@${string}`

/** Where an active package record is owned. Model records are ephemeral and
 * must never be persisted in the installed-package store. */
export type PackageSource = "bundled" | "external" | "model"

/** Browser resource seam. It deliberately exposes only package-relative reads. */
export type PackageResourceProvider = {
  readonly read: (path: string) => string | Uint8Array | Promise<string | Uint8Array>
}

export type PackageResourceMap = Readonly<Record<string, string | Uint8Array>>

/** A validated, immutable package record owned by the installed catalog. */
export type InstalledPackageRecord = {
  readonly key: PackageKey
  readonly source: PackageSource
  readonly manifest: Manifest
  readonly definition: Definition
  /** Every package-relative file, retained byte-for-byte. */
  readonly resources: Readonly<Record<string, Uint8Array>>
  readonly digest: string
  readonly resolvedDependencies: Readonly<Record<string, PackageKey>>
}

export type PackageBundle = {
  readonly manifest: Manifest
  readonly definition: Definition
  readonly resources: PackageResourceProvider | PackageResourceMap
  readonly directory?: string
}

export type Package = PackageBundle | InstalledPackageRecord

/** Raw resources exposed only to the package transport/export boundary. */
export type PackageExportInfo = {
  readonly manifest: Manifest
  /** JSON source for legacy bundled exports, or parsed definition on records. */
  readonly definition: string | Definition
  /** Complete immutable package-relative resources, when available. */
  readonly resources?: Readonly<Record<string, string | Uint8Array>>
  /** Exact dependency resolution persisted by the installed catalog. */
  readonly resolvedDependencies?: Readonly<Record<string, PackageKey>>
  /** Runtime state is carried through transport only to reject unusable records. */
  readonly state?: "installed" | "active" | "failed"
  readonly active?: boolean
  readonly pytorch?: string
}

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

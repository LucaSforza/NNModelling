import type { ModelPackageReference } from "../core/types"
import type { DType, Dimension } from "../type-system/tensor-type"
import type { Definition, Manifest, PackageKind, ParameterDefinition } from "../type-system/packages/types"

export type AuthoringPosition = "top" | "bottom"

/** The scalar forms accepted inside a list parameter. */
export type AuthoringListItemDefinition =
  | { readonly type: "integer"; readonly minimum?: number; readonly maximum?: number; readonly default?: number }
  | { readonly type: "number"; readonly minimum?: number; readonly maximum?: number; readonly default?: number }
  | { readonly type: "boolean"; readonly default?: boolean }
  | { readonly type: "string"; readonly choices?: readonly string[]; readonly default?: string }

/** A parameter row emitted by the authoring form. Position is deliberately required. */
export type AuthoringParameterDefinition =
  | ({ readonly type: "integer"; readonly minimum?: number; readonly maximum?: number; readonly default?: number } & { readonly position: AuthoringPosition })
  | ({ readonly type: "number"; readonly minimum?: number; readonly maximum?: number; readonly default?: number } & { readonly position: AuthoringPosition })
  | ({ readonly type: "boolean"; readonly default?: boolean } & { readonly position: AuthoringPosition })
  | ({ readonly type: "string"; readonly choices?: readonly string[]; readonly default?: string } & { readonly position: AuthoringPosition })
  | ({ readonly type: "dtype"; readonly choices: readonly DType[]; readonly default?: DType } & { readonly position: AuthoringPosition })
  | ({ readonly type: "shape"; readonly default?: readonly Dimension[] } & { readonly position: AuthoringPosition })
  | ({ readonly type: "list"; readonly items: AuthoringListItemDefinition; readonly minItems?: number; readonly maxItems?: number; readonly default?: readonly unknown[] } & { readonly position: AuthoringPosition })
  | ({ readonly type: "stereotype"; readonly kind: PackageKind; readonly default?: { readonly id: string; readonly version: string; readonly parameters: Readonly<Record<string, unknown>> } } & { readonly position: AuthoringPosition })

export type StereotypeParameterRequest = {
  readonly name: string
  readonly definition: AuthoringParameterDefinition
}

export type StereotypeAuthoringRequest = {
  readonly id: string
  readonly version: string
  /** Model-relative package directory, for example `packages/my-layer`. */
  readonly directory: string
  readonly name: string
  readonly description?: string
  readonly kind: PackageKind
  readonly view: { readonly color: string; readonly width: number; readonly height: number }
  readonly dependencies?: Readonly<Record<string, string>>
  readonly parameters: readonly StereotypeParameterRequest[]
  /** Loss objective bindings are structural metadata, not an inferred implementation. */
  readonly objective?: Definition["objective"]
}

export type GeneratedStereotypeResources = {
  readonly manifest: Manifest
  readonly definition: Definition
  readonly modelPackage: ModelPackageReference
  readonly files: Readonly<{
    readonly "manifest.json": string
    readonly "stereotype.json": string
    readonly "inference.lua": string
    readonly "pytorch.py": string
  }>
}

/** Canonical request after validation; useful to forms before submission. */
export type ValidatedStereotypeAuthoringRequest = Omit<StereotypeAuthoringRequest, "dependencies" | "parameters"> & {
  readonly dependencies: Readonly<Record<string, string>>
  readonly parameters: readonly StereotypeParameterRequest[]
}

export type CanonicalParameterDefinition = ParameterDefinition

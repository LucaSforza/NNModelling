/** Immutable v2 serialized type-signature contract. */

export type ExpressionSource = string;
export type SymbolScope = "global" | "local";
export type ConstraintSeverity = "error" | "warning";

export interface PatternShape {
  readonly kind: "pattern";
  readonly dims: readonly DimensionPattern[];
}

export interface ComputedShape {
  readonly kind: "computed_shape";
  readonly expr: ExpressionSource;
}

export interface EinsumShape {
  readonly kind: "einsum";
  readonly equation: { readonly parameter: string };
}

export type ShapeDefinition = PatternShape | ComputedShape | EinsumShape;

export type DimensionPattern =
  | { readonly kind: "const"; readonly value: number }
  | { readonly kind: "wildcard" }
  | { readonly kind: "symbolic"; readonly name: string; readonly scope: SymbolScope }
  | { readonly kind: "param_ref"; readonly name: string }
  | { readonly kind: "param_spread"; readonly name: string }
  | { readonly kind: "computed"; readonly expr: ExpressionSource };

/** One ordered input partition. Bounds describe tensor multiplicity, never rank. */
export interface InputGroup {
  readonly lower: number;
  /** `null` is the sole serialized representation of an unbounded group. */
  readonly upper: number | null;
  readonly label?: string;
  readonly pattern: PatternShape;
}

export interface TypeConstraint {
  readonly condition: ExpressionSource;
  readonly message?: string;
  /** Defaults to `error` when omitted. */
  readonly severity?: ConstraintSeverity;
  readonly category?: string;
}

/**
 * The v2 JSON shape. Expressions are source text; parser ASTs are deliberately
 * absent because they are an internal T02 implementation detail.
 */
export interface SerializedTypeSignatureV2 {
  readonly version: 2;
  readonly inputs: readonly InputGroup[];
  readonly output: ShapeDefinition;
  readonly constraints?: readonly TypeConstraint[];
  readonly from_dtype?: ExpressionSource;
  readonly to_dtype: ExpressionSource;
}

/** A structurally validated, deeply immutable v2 signature. */
export type CompiledTypeSignatureV2 = SerializedTypeSignatureV2;

export interface SchemaDiagnostic {
  readonly pointer: string;
  readonly message: string;
}

export type SchemaResult =
  | { readonly ok: true; readonly value: CompiledTypeSignatureV2 }
  | { readonly ok: false; readonly errors: readonly SchemaDiagnostic[] };

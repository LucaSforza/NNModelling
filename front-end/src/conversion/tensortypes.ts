/** Public tensor annotations and diagnostics. V2 signatures live in type-system/model. */

export type ShapeDimension =
  | { kind: "const"; value: number }
  | { kind: "symbolic"; name: string }
  | { kind: "param_ref"; name: string }
  | { kind: "wildcard" }
  | { kind: "computed"; expr: string }
  | { kind: "param_spread"; param: string; values?: number[] };

export type TensorShape = ShapeDimension[];
export type DType = string;

export interface TensorType {
  shape: TensorShape;
  dtype: DType;
}

export interface TypeError {
  nodeId: string;
  message: string;
  severity: "error" | "warning";
}

export interface TypeWarning {
  nodeId: string;
  message: string;
  kind: "dtype" | "shape" | "perf" | "style";
}

export interface TypeSuggestion {
  nodeId: string;
  param: string;
  value: number;
  reason: string;
}

export interface NodeTypeAnnotation {
  nodeId: string;
  inputType?: TensorType;
  inputTypes?: TensorType[];
  outputType: TensorType;
  blockedBy?: string[];
}

export interface TypeResult {
  ok: boolean;
  annotations: Map<string, NodeTypeAnnotation>;
  errors: TypeError[];
  warnings: TypeWarning[];
  suggestions: TypeSuggestion[];
}

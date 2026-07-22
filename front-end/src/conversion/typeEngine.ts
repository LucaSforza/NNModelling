/**
 * @file Type inference engine for NNModelling diagrams.
 *
 * DATA-DRIVEN constraint-based type inference.  No hardcoded module names,
 * no category checks.  Everything is driven by the `type_signature` field
 * in stereotype JSON files.
 *
 * Phase 1 limitations:
 * - Wildcard in pattern must be the last non-terminal element (no lookahead).
 * - Join type inference is a TODO (Phase 3).
 * - Subflow type inference is a TODO (Phase 4).
 */

import type { Node, Edge } from "@xyflow/svelte";
import type { DiagramCore } from "../core/DiagramCore";
import type { StereotypeCore } from "../core/StereotypeCore";
import type {
  TensorType,
  ShapeDimension,
  ShapeDimPattern,
  ShapePattern,
  TypeSignature,
  TypeError,
  TypeWarning,
  TypeSuggestion,
  Advisory,
  NodeTypeAnnotation,
  TypeResult,
  TypeEnvironment,
  ParamResolution,
} from "./tensortypes";
import { parseExpr, evaluate, ParseError } from "../expr/index";
import type { EvalContext } from "../expr/types";

// ─────────────────────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────────────────────

interface PatternMatchResult {
  success: true;
  /** New or updated symbolic bindings (merged into env after match). */
  bindings: TypeEnvironment;
  /** Dimensions captured by wildcards, in order. */
  captured: ShapeDimension[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export class TypeEngine {
  private static isObservableNode(diagram: DiagramCore, node: Node | undefined): boolean {
    if (!node) return false;
    const stereotype = diagram.getStereotype(String(node.data.stereotype ?? ""));
    return stereotype?.isObservable === true;
  }

  /**
   * Full-graph type inference.
   *
   * 1. Build topological order of all top-level nodes (parentId === undefined).
   * 2. Traverse nodes in topological order, inferring types.
   * 3. Return all annotations, errors, and a summary `ok` flag.
   */
  static infer(diagram: DiagramCore): TypeResult {
    const annotations = new Map<string, NodeTypeAnnotation>();
    const errors: TypeError[] = [];
    const warnings: TypeWarning[] = [];
    const suggestions: TypeSuggestion[] = [];
    const env: TypeEnvironment = new Map();

    // Only top-level nodes (subflow internals deferred to Phase 4)
    const isObservable = (node: Node): boolean => this.isObservableNode(diagram, node);
    const observableIds = new Set(diagram.nodes.filter(isObservable).map((node) => node.id));
    const computationalNodes = diagram.nodes.filter((node) => !isObservable(node));
    const computationalEdges = diagram.edges.filter((edge) => !observableIds.has(edge.target) && !observableIds.has(edge.source));
    const topLevelNodes = computationalNodes.filter((n) => !n.parentId);
    const sortedIds = this.topologicalSort(topLevelNodes, computationalEdges);

    // Cycle detection
    if (sortedIds.length < topLevelNodes.length) {
      errors.push({
        nodeId: "",
        message: "graph contains cycle, partial type inference",
        severity: "warning",
      });
    }

    // Build a fast id→node lookup
    const nodesById = new Map<string, Node>();
    for (const n of diagram.nodes) {
      nodesById.set(n.id, n);
    }

    for (const nodeId of sortedIds) {
      const node = nodesById.get(nodeId);
      if (!node) continue;

      // ── Step a: Get Stereotype ────────────────────────────────────
      const stereoName: string = (node.data as Record<string, unknown>)
        .stereotype as string;
      const stereotype = diagram.getStereotype(stereoName);

      // ── Step b: No type signature — with generic subflow handling ──
      if (!stereotype || !stereotype.typeSignature) {
        // Generic subflow: has children nodes but no stereotype with type_signature
        const hasInternalNodes = diagram.nodes.some((n) => n.parentId === nodeId);
        if (hasInternalNodes) {
          const localParams: Record<string, unknown> = (
            node.data as Record<string, unknown>
          ).params as Record<string, unknown>;
          // Compute input type inline (inputType not yet declared at this point)
          const incEdges = computationalEdges.filter((e) => e.target === nodeId);
          const blockedBy = this.blockedByFromEdges(incEdges, annotations);
          if (blockedBy.length > 0) {
            annotations.set(nodeId, this.blockedAnnotation(nodeId, blockedBy));
            continue;
          }
          let subflowInputType: TensorType | undefined;
          if (incEdges.length === 1) {
            const srcAnn = annotations.get(incEdges[0].source);
            if (srcAnn) subflowInputType = srcAnn.outputType;
          } else if (incEdges.length > 1) {
            // Use first predecessor's type for subflow
            const srcAnn = annotations.get(incEdges[0].source);
            if (srcAnn) subflowInputType = srcAnn.outputType;
          }
          const result = this.inferSubflow(
            nodeId,
            subflowInputType,
            diagram,
            localParams ?? {},
            env,
            annotations,
            errors,
            warnings,
            suggestions,
          );
          if (isTensorType(result)) {
            annotations.set(nodeId, {
              nodeId,
              outputType: result,
              ...(subflowInputType !== undefined ? { inputType: subflowInputType } : {}),
            });
            for (const dim of result.shape) {
              if (dim.kind === "symbolic" && !dim.name.startsWith("#") && !env.has(dim.name)) {
                env.set(dim.name, dim);
              }
            }
          } else {
            if (!result.nodeId) result.nodeId = nodeId;
            errors.push(result);
            annotations.set(nodeId, this.blockedAnnotation(nodeId, [nodeId]));
          }
          continue;
        }

        errors.push({
          nodeId,
          message: stereoName
            ? `No type signature for "${stereoName}"`
            : `Subflow container has no internal nodes`,
          severity: "warning",
        });
        annotations.set(nodeId, {
          nodeId,
          outputType: { shape: [], dtype: "unknown" },
        });
        continue;
      }

      // ── Step c: Get resolved params ──────────────────────────────
      const params: Record<string, unknown> = (
        node.data as Record<string, unknown>
      ).params as Record<string, unknown>;

      const sig = stereotype.typeSignature;

      // ── Step d: Determine input type(s) ──────────────────────────
      const incomingEdges = computationalEdges.filter((e) => e.target === nodeId);
      const blockedBy = this.blockedByFromEdges(incomingEdges, annotations);
      if (blockedBy.length > 0) {
        annotations.set(nodeId, this.blockedAnnotation(nodeId, blockedBy));
        continue;
      }

      let inputType: TensorType | undefined;
      let inputTypes: TensorType[] | undefined;

      if (stereotype.isInput) {
        // Source node — no incoming edges expected
        inputType = undefined;
      } else if (sig.kind === "join") {
        // Join nodes have multiple inputs — collect them
        const collected: TensorType[] = [];
        let allFound = true;
        // Sort by targetHandle for deterministic ordering (in-0, in-1, …)
        const sortedEdges = [...incomingEdges].sort((a, b) => {
          const ha = a.targetHandle ?? "in-0";
          const hb = b.targetHandle ?? "in-0";
          return this.compareTargetHandles(ha, hb);
        });
        for (const e of sortedEdges) {
          const srcAnn = annotations.get(e.source);
          if (srcAnn) {
            if (srcAnn.outputType) collected.push(srcAnn.outputType);
          } else {
            allFound = false;
          }
        }
        if (!allFound) {
          errors.push({
            nodeId,
            message: "Some predecessors have no type annotation",
            severity: "warning",
          });
          continue;
        }
        inputTypes = collected.length > 0 ? collected : undefined;
        // Pass inputTypes to inferNode for join processing
        inputType = undefined;
      } else if (incomingEdges.length === 0) {
        // No predecessor and not Input — floating node, skip silently
        continue;
      } else if (incomingEdges.length === 1) {
        const srcAnn = annotations.get(incomingEdges[0].source);
        if (!srcAnn) {
          errors.push({
            nodeId,
            message: `Predecessor "${incomingEdges[0].source}" has no type annotation`,
            severity: "warning",
          });
          continue;
        }
        inputType = srcAnn.outputType;
      } else {
        // Multiple predecessors but not a join — gather what we can
        const collected: TensorType[] = [];
        let allFound = true;
        for (const e of incomingEdges) {
          const srcAnn = annotations.get(e.source);
          if (srcAnn) {
            if (srcAnn.outputType) collected.push(srcAnn.outputType);
          } else {
            allFound = false;
          }
        }
        if (!allFound) {
          errors.push({
            nodeId,
            message: "Some predecessors have no type annotation",
            severity: "warning",
          });
          continue;
        }
        // Use the first predecessor's type for single-input pattern matching
        inputType = collected[0];
        inputTypes = collected;
      }

      // ── Step e: Call inferNode ───────────────────────────────────
      const errorStart = errors.length;
      const result = this.inferNode(
        inputType,
        stereotype,
        params,
        env,
        inputTypes,
        diagram,
        nodeId,
        annotations,
        errors,
        warnings,
        suggestions,
      );

      // ── Steps f/g: Handle result ─────────────────────────────────
      if (isTensorType(result)) {
        const derivedBlockedBy =
          result.shape.length === 0
            ? this.primaryErrorIds(errors.slice(errorStart))
            : [];
        const annotation: NodeTypeAnnotation = {
          nodeId,
          outputType: result,
        };
        if (derivedBlockedBy.length > 0) annotation.blockedBy = derivedBlockedBy;
        if (inputType !== undefined) {
          annotation.inputType = inputType;
        }
        if (inputTypes !== undefined && inputTypes.length > 1) {
          annotation.inputTypes = inputTypes;
        }
        annotations.set(nodeId, annotation);

        // Update environment with any new symbolic bindings from the output
        for (const dim of result.shape) {
          if (dim.kind === "symbolic" && !dim.name.startsWith("#") && !env.has(dim.name)) {
            env.set(dim.name, dim);
          }
        }
      } else {
        // Patch the nodeId if the callee left it empty
        if (!result.nodeId) {
          result.nodeId = nodeId;
        }
        errors.push(result);
        annotations.set(nodeId, this.blockedAnnotation(nodeId, [nodeId]));
      }
    }

    this.validateObservableCategoryConsistency(diagram, errors);
    this.validateObservables(diagram, observableIds, annotations, errors);
    const uniqueErrors = this.dedupeErrors(errors);
    return {
      ok: uniqueErrors.filter((error) => !error.nodeId || !observableIds.has(error.nodeId)).every((e) => e.severity !== "error"),
      annotations,
      errors: uniqueErrors,
      warnings,
      suggestions,
    };
  }

  private static validateObservableCategoryConsistency(
    diagram: DiagramCore,
    errors: TypeError[],
  ): void {
    for (const node of diagram.nodes) {
      const structuralObservable = node.type === "observable" || node.data.isObservable === true;
      const categoryObservable = this.isObservableNode(diagram, node);
      if (structuralObservable !== categoryObservable) {
        errors.push({
          nodeId: node.id,
          message: `Observable structure does not match stereotype category for node '${node.id}'`,
          severity: "error",
        });
      }
    }
  }

  private static validateObservables(
    diagram: DiagramCore,
    observableIds: Set<string>,
    annotations: Map<string, NodeTypeAnnotation>,
    errors: TypeError[],
  ): void {
    for (const node of diagram.nodes.filter((candidate) => observableIds.has(candidate.id))) {
      const stereo = diagram.getStereotype(String(node.data.stereotype));
      const contract = stereo?.observable;
      const structuralObservable = node.type === "observable" || node.data.isObservable === true;
      if (!stereo?.isObservable || !contract || !structuralObservable) {
        errors.push({ nodeId: node.id, message: "Observable node has no valid Observable stereotype", severity: "error" });
        continue;
      }
      const incoming = diagram.edges
        .filter((edge) => edge.target === node.id)
        .sort((a, b) => this.compareTargetHandles(a.targetHandle ?? "in-0", b.targetHandle ?? "in-0"));
      const inputTypes: TensorType[] = [];
      const signature = stereo.typeSignature;
      const patterns = signature?.kind === "observable" ? signature.input : [];
      for (const edge of diagram.edges.filter((candidate) => candidate.source === node.id)) {
        if (!this.isObservableNode(diagram, diagram.getNodeById(edge.target))) {
          errors.push({ nodeId: node.id, message: "Observable nodes cannot feed computational nodes", severity: "error" });
        }
      }
      const byHandle = new Map<string, Edge[]>();
      for (const edge of incoming) {
        const handle = edge.targetHandle ?? "in-0";
        const existing = byHandle.get(handle) ?? [];
        existing.push(edge);
        byHandle.set(handle, existing);
        if (!contract.inputs.some((input) => input.id === handle)) {
          errors.push({ nodeId: node.id, message: `Unknown Observable target handle '${handle}'`, severity: "error" });
        }
        const source = diagram.getNodeById(edge.source);
        if (!source) {
          errors.push({ nodeId: node.id, message: `Observable source '${edge.source}' does not exist`, severity: "error" });
          continue;
        }
        if (this.isObservableNode(diagram, source)) {
          errors.push({ nodeId: node.id, message: `Observable '${edge.source}' cannot be an observation source`, severity: "error" });
        }
        const sourcePoint = edge.sourceHandle ?? "out";
        const sourceStereo = diagram.getStereotype(String(source.data.stereotype ?? ""));
        if (sourcePoint !== "out" && !sourceStereo?.observablePoints.some((point) => point.id === sourcePoint)) {
          errors.push({ nodeId: node.id, message: `Unknown source point '${sourcePoint}'`, severity: "error" });
        }
      }
      for (let index = 0; index < contract.inputs.length; index++) {
        const input = contract.inputs[index];
        const matchingEdges = byHandle.get(input.id) ?? [];
        if (input.required && matchingEdges.length !== 1) {
          errors.push({ nodeId: node.id, message: `Observable input '${input.label}' requires exactly one connection`, severity: "error" });
        } else if (!input.required && matchingEdges.length > 1) {
          errors.push({ nodeId: node.id, message: `Observable input '${input.label}' has duplicate connections`, severity: "error" });
        }
        const edge = matchingEdges[0];
        if (!edge) {
          continue;
        }
        const source = annotations.get(edge.source);
        if (!source?.outputType) {
          errors.push({ nodeId: node.id, message: `Observable source '${edge.source}' has no computational output`, severity: "error" });
          continue;
        }
        inputTypes.push(source.outputType);
        const pattern = patterns[index];
        if (pattern) {
          const match = this.patternMatch(source.outputType.shape, pattern as ShapePattern, {}, new Map());
          if (isTypeError(match)) errors.push({ nodeId: node.id, message: `${input.label}: ${match.message}`, severity: "error" });
        }
      }
      const params = (node.data.params ?? {}) as Record<string, { value?: string }>;
      const selectedModes = this.parseStringList(params.execution_modes?.value);
      for (const mode of selectedModes) {
        if (!contract.supportedModes.includes(mode)) errors.push({ nodeId: node.id, message: `Execution mode '${mode}' is not supported by ${stereo.name}`, severity: "error" });
      }
      const retention = params.retention_scope?.value ?? contract.defaultRetentionScope;
      if (!contract.supportedRetentionScopes.includes(retention)) errors.push({ nodeId: node.id, message: `Retention scope '${retention}' is not supported`, severity: "error" });
      const storage = params.storage_strategy?.value ?? contract.defaultStorageStrategy;
      if (!contract.supportedStorageStrategies.includes(storage)) errors.push({ nodeId: node.id, message: `Storage strategy '${storage}' is not supported`, severity: "error" });
      annotations.set(node.id, { nodeId: node.id, inputTypes });
    }
  }

  private static parseStringList(value: string | undefined): string[] {
    if (!value) return [];
    try {
      const parsed: unknown = JSON.parse(value.replaceAll("'", '"'));
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [value];
    } catch { return value.split(",").map((item) => item.trim()).filter(Boolean); }
  }

  /**
   * Single-node type inference.
   *
   * Takes an input type, stereotype (with its type_signature), node params,
   * and the current environment, and returns either a concrete output type
   * or a TypeError.
   */
  static inferNode(
    inputType: TensorType | undefined,
    stereotype: StereotypeCore,
    params: Record<string, unknown>,
    env: TypeEnvironment,
    inputTypes?: TensorType[],
    diagram?: DiagramCore,
    nodeId?: string,
    annotations?: Map<string, NodeTypeAnnotation>,
    errors?: TypeError[],
    warnings?: TypeWarning[],
    suggestions?: TypeSuggestion[],
  ): TensorType | TypeError {
    // Safety check: type signature must exist
    const sig = stereotype.typeSignature;
    if (!sig) {
      return {
        nodeId: "",
        message: `No type signature for "${stereotype.name}"`,
        severity: "warning",
      } satisfies TypeError;
    }

    // Validate parameters referenced only by the output pattern as well.
    // Input-side param refs are checked by patternMatch, but output-only refs
    // (for example Linear.out_features) would otherwise degrade to a symbol.
    if (sig.kind !== "observable") {
      for (const outputDim of sig.output) {
        if (outputDim.kind !== "param_ref") continue;
        const resolution = this.resolveParamRef(outputDim.name, params);
        if (resolution.status === "invalid") {
          return {
            nodeId: nodeId ?? "",
            message: `parameter ${outputDim.name} has invalid value "${resolution.value}", expected a number`,
            severity: "error",
          } satisfies TypeError;
        }
      }
    }

    switch (sig.kind) {
      // ── Module kind ────────────────────────────────────────────
      case "module": {
        const inputPattern = sig.input as ShapePattern;

        // Source node with empty pattern → skip input matching
        if (inputType === undefined) {
          if (inputPattern.length === 0) {
            // Produce output from pattern alone (e.g. Input node)
            const outputDims = this.resolvePattern(
              sig.output,
              params,
              env,
              [],
            );
            const dtype = sig.dtype?.output ?? "unknown";

            // ── Evaluate advisories (Phase B) ────────────────
            if (sig.advisories && warnings && nodeId) {
              for (const advisory of sig.advisories) {
                const warning = this.evaluateAdvisory(
                  advisory,
                  env,
                  params,
                  nodeId,
                );
                if (warning) {
                  warnings.push(warning);
                }
              }
            }

            return { shape: outputDims, dtype } satisfies TensorType;
          }

          // Non-empty pattern but no input → error
          return {
            nodeId: "",
            message: `"${stereotype.name}" expects input but has no predecessor`,
            severity: "error",
          } satisfies TypeError;
        }

        // Normal case: match input against pattern
        const startSuggLen = suggestions?.length ?? 0;
        const matchResult = this.patternMatch(
          inputType.shape,
          inputPattern,
          params,
          env,
          suggestions,
        );

        if (isTypeError(matchResult)) {
          return matchResult;
        }

        // Set nodeId on any new suggestions added by patternMatch
        if (suggestions && nodeId) {
          for (let si = startSuggLen; si < suggestions.length; si++) {
            suggestions[si].nodeId = nodeId;
          }
        }

        // Merge new bindings into env for downstream use.
        // Only propagate global ($-prefixed) bindings —
        // #-local bindings are scoped to the current stereotype's
        // inputs/outputs only and must not leak into the global env.
        for (const [key, value] of matchResult.bindings) {
          if (!key.startsWith("#")) {
            env.set(key, value);
          }
        }

        // ── Dtype input validation (Phase A) ─────────────────────
        // Validate incoming dtype against declared contract.
        // Warning, not error — PyTorch handles most conversions.
        if (sig.dtype?.input && inputType.dtype !== sig.dtype.input && warnings && nodeId) {
          warnings.push({
            nodeId,
            message: `"${stereotype.name}" expects ${sig.dtype.input} input, got ${inputType.dtype}`,
            kind: "dtype",
          });
        }

        // Create augmented env for output resolution: include #-local bindings
        // so that #L → 50 gets resolved to const 50 in the output shape,
        // while downstream nodes don't see #-local variables.
        const outputEnv = new Map(env);
        for (const [key, value] of matchResult.bindings) {
          if (key.startsWith("#")) {
            outputEnv.set(key, value);
          }
        }

        const outputDims = this.resolvePattern(
          sig.output,
          params,
          outputEnv,
          matchResult.captured,
        );
        const dtype = sig.dtype?.output ?? inputType.dtype;

        // ── Evaluate advisories (Phase B) ──────────────────────
        if (sig.advisories && warnings && nodeId) {
          for (const advisory of sig.advisories) {
            const warning = this.evaluateAdvisory(
              advisory,
              outputEnv,
              params,
              nodeId,
            );
            if (warning) {
              warnings.push(warning);
            }
          }
        }

        return { shape: outputDims, dtype } satisfies TensorType;
      }

      // ── Join kind — Phase 3 ──────────────────────────────────
      case "join": {
        const inputPatterns = sig.input as ShapePattern[];

        if (!inputTypes || inputTypes.length === 0) {
          return {
            nodeId: "",
            message: `Join node "${stereotype.name}" has no inputs`,
            severity: "error",
          } satisfies TypeError;
        }

        // ── Einsum short-circuit: handle BEFORE pattern matching ──
        if (sig.join?.action === 'einsum') {
          const paramName = sig.join.einsum_param ?? 'expr';
          const equation = this.extractParamString(paramName, params);
          if (!equation || equation.length === 0) {
            return {
              nodeId: "",
              message: `"${stereotype.name}" expression is empty`,
              severity: "error",
            } satisfies TypeError;
          }
          const outputShape = this.inferEinsumShape(equation, inputTypes, stereotype.name);
          if (!Array.isArray(outputShape)) return outputShape;
          return { shape: outputShape, dtype: inputTypes[0].dtype } satisfies TensorType;
        }

        if (inputPatterns.length !== inputTypes.length) {
          return {
            nodeId: "",
            message: `Join node "${stereotype.name}" expects ${inputPatterns.length} inputs but got ${inputTypes.length}`,
            severity: "error",
          } satisfies TypeError;
        }

        // Phase D: input_labels for better error messages
        const inputLabels = sig.join?.input_labels ?? [];

        // Step 1: Match each input pattern against corresponding input type
        const allBindings: TypeEnvironment[] = [];
        const allCaptured: ShapeDimension[][] = [];

        for (let k = 0; k < inputPatterns.length; k++) {
          const pat = inputPatterns[k];
          const inp = inputTypes[k];
          if (!inp) continue;

          const label = inputLabels[k] ?? `Input ${k}`;

          const matchResult = this.patternMatch(inp.shape, pat, params, env);
          if (isTypeError(matchResult)) {
            return {
              nodeId: "",
              message: `${label} mismatch: ${matchResult.message}`,
              severity: matchResult.severity,
            } satisfies TypeError;
          }

          allCaptured.push(matchResult.captured);
          allBindings.push(matchResult.bindings);
        }

        // ── Verify all inputs have compatible shapes (captured dims match) ──
        // For joins with wildcard patterns (e.g. Addition, element-wise ops),
        // all inputs must have identical shapes.  We verify by comparing captured
        // dims across inputs: same length and equal dimension values.
        // This check is SKIPPED for concat joins (where the concat dim differs).
        if (allCaptured.length >= 2 && sig.join?.action !== "concat") {
          const first = allCaptured[0];
          for (let k = 1; k < allCaptured.length; k++) {
            const other = allCaptured[k];
            const label = inputLabels[k] ?? `Input ${k}`;

            if (first.length !== other.length) {
              return {
                nodeId: "",
                message: `${label} shape length mismatch: expected ${first.length} dims, got ${other.length}`,
                severity: "error",
              } satisfies TypeError;
            }
            for (let d = 0; d < first.length; d++) {
              if (!dimEqual(first[d], other[d])) {
                return {
                  nodeId: "",
                  message: `${label} dimension ${d} mismatch: ${this.describeDim(first[d])} vs ${this.describeDim(other[d])}`,
                  severity: "error",
                } satisfies TypeError;
              }
            }
          }
        }

        // Step 2: Merge symbolic bindings across all inputs (unification)
        const mergedEnv: TypeEnvironment = new Map(env);
        for (const bindings of allBindings) {
          for (const [name, dim] of bindings) {
            const existing = mergedEnv.get(name);
            if (existing !== undefined) {
              if (!dimEqual(existing, dim)) {
                return {
                  nodeId: "",
                  message: `Symbolic $${name} bound to conflicting values: ${this.describeDim(existing)} vs ${this.describeDim(dim)}`,
                  severity: "error",
                } satisfies TypeError;
              }
            } else {
              mergedEnv.set(name, dim);
            }
          }
        }

        // Merge mergedEnv into env for downstream use.
        // Only propagate non-# bindings (same as module path).
        for (const [key, value] of mergedEnv) {
          if (!key.startsWith("#")) {
            env.set(key, value);
          }
        }

        // Step 3: Compute output shape
        let outputDims: ShapeDimension[];

        if (sig.join?.action === "concat") {
          // Concat join: resolve dim from expression, sum inputs on that dim
          const dimExpr = sig.join.dim_expr ?? "-1";
          let concatDim: number | undefined;

          // Try the expression evaluator
          try {
            const context: EvalContext = {
              env,
              captured: [],
              params,
              resolveParam: (name: string) => {
                const resolved = TypeEngine.resolveParamRef(name, params);
                if (resolved.status === "resolved") return resolved.value;
                return undefined;
              },
            };
            const ast = parseExpr(dimExpr);
            const evaluated = evaluate(ast, context);
            if (evaluated !== undefined) {
              concatDim = evaluated;
            }
          } catch (e) {
            if (e instanceof ParseError) {
              // Malformed expression — fall through to resolveParamRef fallback
            } else {
              throw e;
            }
          }

          // Fallback: resolve param directly (handles wrapped value format)
          if (concatDim === undefined) {
            const resolved = this.resolveParamRef(dimExpr, params);
            if (resolved.status === "resolved") {
              concatDim = resolved.value;
            }
          }

          if (concatDim === undefined) {
            return {
              nodeId: "",
              message: `Invalid concat dim "${dimExpr}" for "${stereotype.name}"`,
              severity: "error",
            } satisfies TypeError;
          }

          // Wrap negative dim (e.g. -1 → last dim)
          if (concatDim < 0 && inputTypes.length > 0) {
            concatDim = inputTypes[0].shape.length + concatDim;
          }

          if (!Number.isInteger(concatDim)) {
            return {
              nodeId: "",
              message: `Concat dim must be an integer, got ${concatDim}`,
              severity: "error",
            } satisfies TypeError;
          }

          const expectedRank = inputTypes[0].shape.length;
          if (concatDim < 0 || concatDim >= expectedRank) {
            return {
              nodeId: "",
              message: `Concat dim ${concatDim} is out of range for rank ${expectedRank}`,
              severity: "error",
            } satisfies TypeError;
          }

          for (let idx = 1; idx < inputTypes.length; idx++) {
            const actualRank = inputTypes[idx].shape.length;
            if (actualRank !== expectedRank) {
              return {
                nodeId: "",
                message: `Concat input ${idx} rank mismatch: expected ${expectedRank}, got ${actualRank}`,
                severity: "error",
              } satisfies TypeError;
            }
          }

          outputDims = this.resolveConcatOutput(inputTypes, concatDim);

          // Verify non-concat dims match across all inputs
          for (let idx = 1; idx < inputTypes.length; idx++) {
            for (let d = 0; d < inputTypes[0].shape.length; d++) {
              if (d === concatDim) continue;
              if (!dimEqual(inputTypes[0].shape[d], inputTypes[idx].shape[d])) {
                return {
                  nodeId: "",
                  message: `Concat input ${idx} dimension ${d} mismatch: expected ${this.describeDim(inputTypes[0].shape[d])}, got ${this.describeDim(inputTypes[idx].shape[d])}`,
                  severity: "error",
                } satisfies TypeError;
              }
            }
          }
        } else {
          // Standard join: resolve output pattern with merged env
          // Use only the first input's captured dims for output resolution;
          // other inputs are for verification only.
          const outputCaptured = allCaptured.length > 0 ? allCaptured[0] : [];
          outputDims = this.resolvePattern(
            sig.output,
            params,
            mergedEnv,
            outputCaptured,
          );
        }

        const dtype = sig.dtype?.output ?? inputTypes[0].dtype;

        return { shape: outputDims, dtype } satisfies TensorType;
      }

      // ── Subflow kind (Phase 4) — declarative subflow transforms ──────
      case "subflow": {
        const subCfg = sig.subflow;
        const action = subCfg?.action ?? "infer"; // default: generic subflow
        // Shared maps for writing internal node annotations/errors
        const subflowAnnotations = annotations ?? new Map<string, NodeTypeAnnotation>();
        const subflowErrors = errors ?? [];

        switch (action) {
          // ── identity: shape-preserving (Repeat equivalent) ──
          case "identity": {
            if (!inputType) {
              return {
                nodeId: "",
                message: "Subflow has no input",
                severity: "error",
              } satisfies TypeError;
            }
            // Still infer internal nodes for annotations (side effects),
            // but output type is always identity (input shape preserved).
            if (diagram && nodeId) {
              const internalResult = this.inferSubflow(
                nodeId,
                inputType,
                diagram,
                params,
                env,
                subflowAnnotations,
                subflowErrors,
                warnings,
                suggestions,
              );
              // Surface internal inference errors, but keep identity output
              if (!isTensorType(internalResult)) {
                if (!internalResult.nodeId) internalResult.nodeId = nodeId;
                subflowErrors.push(internalResult);
              }
            }
            // Output shape = input shape (deep copy dims to avoid aliasing)
            return {
              shape: inputType.shape.map((d) => ({ ...d })),
              dtype: inputType.dtype,
            } satisfies TensorType;
          }

          // ── infer: generic subflow recursive inference ─────
          case "infer": {
            if (!diagram || !nodeId) {
              return {
                nodeId: "",
                message: "Cannot infer subflow without diagram context",
                severity: "error",
              } satisfies TypeError;
            }
            return this.inferSubflow(
              nodeId,
              inputType,
              diagram,
              params,
              env,
              subflowAnnotations,
              subflowErrors,
              warnings,
              suggestions,
            );
          }

          // ── repeat: compose the internal transform N times ─────
          case "repeat": {
            if (!inputType) {
              return {
                nodeId: nodeId ?? "",
                message: "Subflow has no input",
                severity: "error",
              } satisfies TypeError;
            }
            if (!diagram || !nodeId) {
              return {
                nodeId: nodeId ?? "",
                message: "Cannot infer repeated subflow without diagram context",
                severity: "error",
              } satisfies TypeError;
            }

            const iterationsParam = subCfg?.iterations_param ?? "iterations";
            const iterationsResult = this.resolveParamRef(iterationsParam, params);
            if (iterationsResult.status !== "resolved") {
              return {
                nodeId,
                message: `Repeat cannot resolve parameter "${iterationsParam}"`,
                severity: "error",
              } satisfies TypeError;
            }
            const iterations = iterationsResult.value;
            if (!Number.isInteger(iterations) || iterations < 1) {
              return {
                nodeId,
                message: `Repeat parameter "${iterationsParam}" must be an integer >= 1, got ${iterations}`,
                severity: "error",
              } satisfies TypeError;
            }

            let currentType = inputType;
            for (let iteration = 0; iteration < iterations; iteration++) {
              const iterationErrorStart = subflowErrors.length;
              const iterationResult = this.inferSubflow(
                nodeId,
                currentType,
                diagram,
                params,
                env,
                subflowAnnotations,
                subflowErrors,
                warnings,
                suggestions,
              );
              if (!isTensorType(iterationResult)) return iterationResult;
              currentType = iterationResult;
              if (
                currentType.shape.length === 0 &&
                currentType.dtype === "unknown" &&
                subflowErrors.length > iterationErrorStart
              ) {
                break;
              }
            }
            return currentType;
          }

          // ── infer_then_transform: infer internal, then apply transform ──
          case "infer_then_transform": {
            if (!inputType) {
              return {
                nodeId: "",
                message: "Subflow has no input",
                severity: "error",
              } satisfies TypeError;
            }
            if (!diagram || !nodeId) {
              return {
                nodeId: "",
                message: "Cannot infer subflow without diagram context",
                severity: "error",
              } satisfies TypeError;
            }
            const internalResult = this.inferSubflow(
              nodeId,
              inputType,
              diagram,
              params,
              env,
              subflowAnnotations,
              subflowErrors,
              warnings,
              suggestions,
            );
            if (!isTensorType(internalResult)) return internalResult;

            // Apply transform
            if (subCfg?.transform?.last_dim?.kind === "multiply") {
              const nExpr = subCfg.transform.last_dim.expr;
              const context: EvalContext = {
                env,
                captured: [],
                params,
                resolveParam: (name: string) => {
                  const resolved = TypeEngine.resolveParamRef(name, params);
                  if (resolved.status === "resolved") return resolved.value;
                  return undefined;
                },
              };
              try {
                const ast = parseExpr(nExpr);
                const n = evaluate(ast, context);
                if (n === undefined) {
                  return {
                    nodeId: nodeId ?? "",
                    message: "Subflow transform cannot resolve parameter for expression",
                    severity: "error",
                  } satisfies TypeError;
                }
                const newShape = internalResult.shape.map((d, i, arr) => {
                  if (i === arr.length - 1 && d.kind === "const") {
                    return { kind: "const" as const, value: d.value * n };
                  }
                  return { ...d };
                });
                return { shape: newShape, dtype: internalResult.dtype } satisfies TensorType;
              } catch (e) {
                if (e instanceof ParseError) {
                  return {
                    nodeId: nodeId ?? "",
                    message: `Invalid transform expression "${nExpr}": ${e.message}`,
                    severity: "error",
                  } satisfies TypeError;
                }
                throw e;
              }
            }
            return internalResult; // fallback: no transform specified
          }

          default:
            return {
              nodeId: nodeId ?? "",
              message: `Unknown subflow action "${action}" for "${stereotype.name}"`,
              severity: "error",
            } satisfies TypeError;
        }
      }

      case "observable":
        return {
          nodeId: nodeId ?? "",
          message: `Observable "${stereotype.name}" has no computational output`,
          severity: "error",
        } satisfies TypeError;

      default:
        return {
          nodeId: "",
          message: `Unknown type signature kind "${(sig as TypeSignature).kind}" for "${stereotype.name}"`,
          severity: "warning",
        } satisfies TypeError;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Subflow inference (Phase 4)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Recursive type inference for a generic subflow container.
   *
   * 1. Collects internal child nodes (parentId === subflowNodeId).
   * 2. Finds the internal Input node and injects the external input type.
   * 3. Runs topological sort on internal nodes.
   * 4. Calls inferNode for each internal node (recursing into nested subflows).
   * 5. Returns the output type of the first exit node.
   */
  private static inferSubflow(
    subflowNodeId: string,
    externalInputType: TensorType | undefined,
    diagram: DiagramCore,
    params: Record<string, unknown>,
    env: TypeEnvironment,
    annotations: Map<string, NodeTypeAnnotation>,
    errors: TypeError[],
    warnings?: TypeWarning[],
    suggestions?: TypeSuggestion[],
  ): TensorType | TypeError {
    // 1. Collect internal nodes
    const internalNodes = diagram.nodes.filter(
      (n) => n.parentId === subflowNodeId && !this.isObservableNode(diagram, n),
    );
    if (internalNodes.length === 0) {
      return {
        nodeId: subflowNodeId,
        message: "Subflow has no internal nodes",
        severity: "warning",
      } satisfies TypeError;
    }

    // 2. Collect internal edges (both ends inside the subflow)
    const internalNodeIds = new Set(internalNodes.map((n) => n.id));
    const internalEdges = diagram.edges.filter(
      (e) =>
        internalNodeIds.has(e.source) && internalNodeIds.has(e.target),
    );
    const computationalInternalEdges = internalEdges.filter((edge) => {
      const source = diagram.getNodeById(edge.source);
      const target = diagram.getNodeById(edge.target);
      return !this.isObservableNode(diagram, source) && !this.isObservableNode(diagram, target);
    });

    // 3. Find the single entry node (internal Input or topological source).
    const declaredInputs = internalNodes.filter((n) => {
      const stereo = diagram.getStereotype(
        (n.data as Record<string, unknown>).stereotype as string,
      );
      return stereo?.isInput;
    });

    if (declaredInputs.length > 1) {
      return {
        nodeId: subflowNodeId,
        message: `Subflow must have exactly one entry, found ${declaredInputs.length} Input nodes`,
        severity: "error",
      } satisfies TypeError;
    }

    let entryNode: Node | undefined = declaredInputs[0];

    // Fallback: if no Input node, use node(s) with no internal incoming edges
    if (!entryNode) {
      const sources = internalNodes.filter(
        (n) => !computationalInternalEdges.some((e) => e.target === n.id),
      );
      if (sources.length !== 1) {
        return {
          nodeId: subflowNodeId,
          message: `Subflow must have exactly one entry, found ${sources.length}`,
          severity: "error",
        } satisfies TypeError;
      }
      entryNode = sources[0];
    }

    if (!entryNode) {
      return {
        nodeId: subflowNodeId,
        message: "Subflow has no internal Input node",
        severity: "error",
      } satisfies TypeError;
    }

    // 4. Find exit node(s) — internal nodes with no internal outgoing edges.
    //    The entry node CAN be an exit too (single-node subflows).
    let exitNodes = internalNodes.filter(
      (n) => !computationalInternalEdges.some((e) => e.source === n.id),
    );
    if (exitNodes.length === 0) {
      return {
        nodeId: subflowNodeId,
        message: "Could not determine subflow exit node",
        severity: "error",
      } satisfies TypeError;
    }
    if (exitNodes.length > 1) {
      return {
        nodeId: subflowNodeId,
        message: `Subflow must have exactly one exit, found ${exitNodes.length}`,
        severity: "error",
      } satisfies TypeError;
    }

    // 5. Seed annotations for Input entry node.
    //    For Input entry nodes: seed with externalInputType as output
    //    (Input just passes through). For other entry nodes (e.g. nested subflow
    //    containers), we don't seed — the external input is passed as input to
    //    the entry node during processing below.
    const entryStereo = diagram.getStereotype(
      (entryNode.data as Record<string, unknown>).stereotype as string,
    );
    const isEntryInput = entryStereo?.isInput ?? false;
    if (externalInputType && isEntryInput) {
      annotations.set(entryNode.id, {
        nodeId: entryNode.id,
        outputType: externalInputType,
      });
    }

    // 6. Topological sort internal nodes
    const sortedIds = this.topologicalSort(internalNodes.filter((n) => !this.isObservableNode(diagram, n)), computationalInternalEdges);

    // 7. Build fast id→node lookup
    const nodesById = new Map<string, Node>();
    for (const n of internalNodes) {
      nodesById.set(n.id, n);
    }

    const localEnv: TypeEnvironment = new Map(env);

    // 8. Walk internal nodes (skip Input entry node if already seeded)
    for (const internalNodeId of sortedIds) {
      const isEntry = internalNodeId === entryNode.id;
      if (isEntry && isEntryInput && externalInputType) continue; // Already seeded

      const n = nodesById.get(internalNodeId);
      if (!n) continue;

      // 8a. Get stereotype
      const stereoName = (n.data as Record<string, unknown>)
        .stereotype as string;
      const stereotype = diagram.getStereotype(stereoName);

      // 8b. No type signature — check for nested subflow or skip
      if (!stereotype || !stereotype.typeSignature) {
        const hasInternalChildren = diagram.nodes.some(
          (cn) => cn.parentId === internalNodeId,
        );
        if (hasInternalChildren) {
          // Recursive subflow inference for nested generic subflow
          // Compute input type: entry node gets externalInputType,
          // other nodes get it from internal predecessor annotations
          let nestedInputType: TensorType | undefined;
          const nestedIncomingEdges = computationalInternalEdges.filter(
            (e) => e.target === internalNodeId,
          );
          const blockedBy = this.blockedByFromEdges(nestedIncomingEdges, annotations);
          if (blockedBy.length > 0) {
            annotations.set(
              internalNodeId,
              this.blockedAnnotation(internalNodeId, blockedBy),
            );
            continue;
          }
          if (isEntry && externalInputType) {
            nestedInputType = externalInputType;
          } else {
            const incomingEdges = computationalInternalEdges.filter(
              (e) => e.target === internalNodeId,
            );
            if (incomingEdges.length === 1) {
              const srcAnn = annotations.get(
                incomingEdges[0].source,
              );
              if (srcAnn)
                nestedInputType = srcAnn.outputType;
            }
          }
          const nestedResult = this.inferSubflow(
            internalNodeId,
            nestedInputType,
            diagram,
            (n.data as Record<string, unknown>)
              .params as Record<string, unknown> ?? {},
            localEnv,
            annotations,
            errors,
            warnings,
            suggestions,
          );
          if (isTensorType(nestedResult)) {
            annotations.set(internalNodeId, {
              nodeId: internalNodeId,
              outputType: nestedResult,
            });
          } else {
            // Structural error from nested subflow (no Input, no exit, etc.)
            // Return as before — shows on the subflow container
            return {
              nodeId: subflowNodeId,
              message: `[Subflow] ${nestedResult.message}`,
              severity: nestedResult.severity,
            } satisfies TypeError;
          }
        } else {
          // Non-subflow node without type signature — warning
          annotations.set(internalNodeId, {
            nodeId: internalNodeId,
            outputType: { shape: [], dtype: "unknown" },
          });
        }
        continue;
      }

      // 8c. Get resolved params
      const localParams: Record<string, unknown> = (
        n.data as Record<string, unknown>
      ).params as Record<string, unknown>;

      const sig = stereotype.typeSignature;

      // 8d. Determine input type from internal edges
      const localIncomingEdges = computationalInternalEdges.filter(
        (e) => e.target === internalNodeId,
      );
      const blockedBy = this.blockedByFromEdges(localIncomingEdges, annotations);
      if (blockedBy.length > 0) {
        annotations.set(
          internalNodeId,
          this.blockedAnnotation(internalNodeId, blockedBy),
        );
        continue;
      }

      let localInputType: TensorType | undefined;
      let localInputTypes: TensorType[] | undefined;

      // Entry node that is not an Input receives the external input type
      if (isEntry && !isEntryInput && externalInputType) {
        localInputType = externalInputType;
      } else if (stereotype.isInput) {
        localInputType = undefined;
      } else if (sig.kind === "join") {
        const collected: TensorType[] = [];
        const sortedEdges = [...localIncomingEdges].sort((a, b) => {
          const ha = a.targetHandle ?? "in-0";
          const hb = b.targetHandle ?? "in-0";
          return this.compareTargetHandles(ha, hb);
        });
        for (const e of sortedEdges) {
          const srcAnn = annotations.get(e.source);
          if (srcAnn?.outputType) collected.push(srcAnn.outputType);
        }
        localInputTypes =
          collected.length > 0 ? collected : undefined;
      } else if (localIncomingEdges.length === 1) {
        const srcAnn = annotations.get(
          localIncomingEdges[0].source,
        );
        if (srcAnn) localInputType = srcAnn.outputType;
      }

      // 8e. Call inferNode on the internal node (handles Repeat, HorizontalRepeat, module, join)
      const errorStart = errors.length;
      const result = this.inferNode(
        localInputType,
        stereotype,
        localParams,
        localEnv,
        localInputTypes,
        diagram,
        internalNodeId,
        annotations,
        errors,
        warnings,
        suggestions,
      );

      if (isTensorType(result)) {
        // Repeated subflows reuse the same node IDs for every iteration. If a
        // previous iteration hit an error downstream, the next iteration can
        // receive the unknown fallback and produce an empty shape. Do not let
        // that fallback erase a useful annotation produced by an earlier
        // iteration; the original error is already recorded separately.
        const previousAnnotation = annotations.get(internalNodeId);
        const hasUnknownInput =
          (localInputType?.shape.length === 0 && localInputType.dtype === "unknown") ||
          (localInputTypes !== undefined &&
            localInputTypes.length > 0 &&
            localInputTypes.every(
              (input) => input.shape.length === 0 && input.dtype === "unknown",
            ));
        const preservesUsefulType =
          hasUnknownInput &&
          (previousAnnotation?.outputType?.shape.length ?? 0) > 0;
        if (!preservesUsefulType) {
          annotations.set(internalNodeId, {
            nodeId: internalNodeId,
            outputType: result,
            ...(result.shape.length === 0
              ? { blockedBy: this.primaryErrorIds(errors.slice(errorStart)) }
              : {}),
          });
        }
        for (const dim of result.shape) {
          if (dim.kind === "symbolic" && !dim.name.startsWith("#") && !localEnv.has(dim.name)) {
            localEnv.set(dim.name, dim);
          }
        }
      } else {
        // Push internal error with correct nodeId (the inferNode TypeError already
        // has nodeId="" — patch it to the internal node ID)
        if (!result.nodeId) {
          result.nodeId = internalNodeId;
        }
        errors.push(result);
        annotations.set(
          internalNodeId,
          this.blockedAnnotation(internalNodeId, [internalNodeId]),
        );
      }
    }

    // 9. Return the single exit node's output type
    const exitNode = exitNodes[0];
    const exitAnn = annotations.get(exitNode.id);
    if (!exitAnn?.outputType) {
      return {
        nodeId: subflowNodeId,
        message: "Subflow exit node has no type annotation",
        severity: "error",
      } satisfies TypeError;
    }

    return {
      shape: [...exitAnn.outputType.shape],
      dtype: exitAnn.outputType.dtype,
    } satisfies TensorType;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Formula resolution (Phase 2 — computed dimensions)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Compute the output shape for a Concat join.
   * Uses the first input's shape as a template and sums values on concatDim.
   * If any input's concat dim is non-const, falls back to the template.
   */
  private static resolveConcatOutput(
    inputTypes: TensorType[],
    concatDim: number,
  ): ShapeDimension[] {
    if (inputTypes.length === 0) return [];
    const template = inputTypes[0];
    if (concatDim < 0 || concatDim >= template.shape.length) {
      return template.shape.map((d) => ({ ...d }));
    }

    // Sum const values on concat dim across all inputs
    let total = 0;
    let allConst = true;
    for (const inp of inputTypes) {
      const dim = inp.shape[concatDim];
      if (dim.kind === "const") {
        total += dim.value;
      } else {
        allConst = false;
        break;
      }
    }

    const shape = template.shape.map((d) => ({ ...d }));
    if (allConst) {
      shape[concatDim] = { kind: "const" as const, value: total };
    }
    return shape;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Kahn's topological sort.
   * Only processes edges where both source and target are in the given node list.
   * Returns node IDs in topological order.
   */
  private static topologicalSort(
    nodes: Node[],
    edges: Edge[],
  ): string[] {
    const nodeIds = new Set(nodes.map((n) => n.id));

    // Build adjacency list and in-degree map
    const adj = new Map<string, string[]>();
    const inDegree = new Map<string, number>();

    for (const n of nodes) {
      adj.set(n.id, []);
      inDegree.set(n.id, 0);
    }

    for (const e of edges) {
      if (nodeIds.has(e.source) && nodeIds.has(e.target)) {
        adj.get(e.source)!.push(e.target);
        inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
      }
    }

    // Queue of nodes with in-degree 0
    const queue: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    const sorted: string[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      sorted.push(id);

      for (const child of adj.get(id) ?? []) {
        const newDeg = (inDegree.get(child) ?? 1) - 1;
        inDegree.set(child, newDeg);
        if (newDeg === 0) queue.push(child);
      }
    }

    return sorted;
  }

  /**
   * Pattern matching — core algorithm.
   *
   * Matches a resolved input shape against a declared pattern, returning
   * symbolic bindings and captured wildcard dimensions.
   */
  private static patternMatch(
    inputDims: ShapeDimension[],
    pattern: ShapePattern,
    params: Record<string, unknown>,
    env: TypeEnvironment,
    suggestions?: TypeSuggestion[],
  ): PatternMatchResult | TypeError {
    // Count wildcards — Phase 1 allows at most one
    const wildcardCount = pattern.filter((p) => p.kind === "wildcard").length;
    if (wildcardCount > 1) {
      return {
        nodeId: "",
        message: "only one wildcard allowed per pattern in Phase 1",
        severity: "error",
      } satisfies TypeError;
    }

    let i = 0; // index into inputDims
    let j = 0; // index into pattern
    const bindings = new Map(env); // copy existing environment
    const captured: ShapeDimension[] = [];

    while (j < pattern.length) {
      const p = pattern[j];

      switch (p.kind) {
        // ── const ─────────────────────────────────────────────
        case "const": {
          if (i >= inputDims.length) {
            return {
              nodeId: "",
              message: `expected dim at position ${j}, got end of shape`,
              severity: "error",
            } satisfies TypeError;
          }
          const constDim = inputDims[i];
          if (
            constDim.kind !== "const" ||
            constDim.value !== p.value
          ) {
            return {
              nodeId: "",
              message: `dimension mismatch at position ${j}: expected ${p.value}, got ${this.describeDim(constDim)}`,
              severity: "error",
            } satisfies TypeError;
          }
          i++;
          j++;
          break;
        }

        // ── symbolic ─────────────────────────────────────────
        case "symbolic": {
          if (i >= inputDims.length) {
            return {
              nodeId: "",
              message: `expected dim at position ${j}, got end of shape`,
              severity: "error",
            } satisfies TypeError;
          }
          // #-prefixed: always fresh binding, never look up in global env.
          // These unify only within the current stereotype's scope
          // (cross-input for joins, via bindings accumulated in this match).
          if (p.name.startsWith("#")) {
            const prev = bindings.get(p.name);
            if (prev !== undefined) {
              if (!dimEqual(prev, inputDims[i])) {
                return {
                  nodeId: "",
                  message: `symbolic ${p.name} already bound to ${this.describeDim(prev)}, cannot unify with ${this.describeDim(inputDims[i])}`,
                  severity: "error",
                } satisfies TypeError;
              }
            } else {
              bindings.set(p.name, inputDims[i]);
            }
            i++;
            j++;
            break;
          }
          const existing = bindings.get(p.name);
          if (existing !== undefined) {
            // Already bound — unify
            if (!dimEqual(existing, inputDims[i])) {
              return {
                nodeId: "",
                message: `symbolic $${p.name} already bound to ${this.describeDim(existing)}, cannot unify with ${this.describeDim(inputDims[i])}`,
                severity: "error",
              } satisfies TypeError;
            }
          } else {
            // First occurrence — bind
            bindings.set(p.name, inputDims[i]);
          }
          i++;
          j++;
          break;
        }

        // ── param_ref ────────────────────────────────────────
        case "param_ref": {
          const resolved = this.resolveParamRef(p.name, params);
          if (resolved.status === 'unset') {
            // Param is "Undefined"/missing — treat as symbolic
            captured.push({ kind: "symbolic", name: `?${p.name}` });
            // If the input dimension at this position is a const, suggest it
            if (suggestions && i < inputDims.length) {
              const inputDim = inputDims[i];
              if (inputDim.kind === 'const') {
                suggestions.push({
                  nodeId: '',
                  param: p.name,
                  value: inputDim.value,
                  reason: `matches input dimension at position ${j}`
                });
              }
            }
            i++;
            j++;
          } else if (resolved.status === 'invalid') {
            // Param has a non-numeric value — type error
            return {
              nodeId: "",
              message: `parameter ${p.name} has invalid value "${resolved.value}", expected a number`,
              severity: "error",
            } satisfies TypeError;
          } else {
            // resolved.status === 'resolved'
            if (i >= inputDims.length) {
              return {
                nodeId: "",
                message: `expected dim at position ${j}, got end of shape`,
                severity: "error",
              } satisfies TypeError;
            }
            const paramDim = inputDims[i];
            if (
              paramDim.kind !== "const" ||
              paramDim.value !== resolved.value
            ) {
              return {
                nodeId: "",
                message: `dimension mismatch: param ${p.name}=${resolved.value}, got ${this.describeDim(paramDim)}`,
                severity: "error",
              } satisfies TypeError;
            }
            i++;
            j++;
          }
          break;
        }

        // ── computed (pass-through — no input validation) ────
        case "computed": {
          // Computed dims in the input pattern just require the
          // dimension to exist; the exact value is not validated
          // since computed dims are primarily output-side constraints.
          if (i >= inputDims.length) {
            return {
              nodeId: "",
              message: `expected dim at position ${j}, got end of shape`,
              severity: "error",
            } satisfies TypeError;
          }
          i++;
          j++;
          break;
        }

        // ── wildcard ─────────────────────────────────────────
        case "wildcard": {
          // Count how many non-wildcard pattern elements follow.
          // The wildcard consumes all input dims except those reserved
          // for subsequent required pattern elements.
          let remainingRequired = 0;
          for (let k = j + 1; k < pattern.length; k++) {
            if (pattern[k].kind !== "wildcard") remainingRequired++;
          }

          // How many input dims remain?
          const available = inputDims.length - i;
          const toConsume = Math.max(0, available - remainingRequired);

          // Consume the wildcard dims
          for (let c = 0; c < toConsume; c++) {
            captured.push(inputDims[i]);
            i++;
          }
          j++;
          break;
        }

        // ── param_spread ────────────────────────────────────
        case "param_spread": {
          // In input pattern: resolve the tuple param to get N,
          // then consume exactly N dims from input.
          const tuple = TypeEngine.resolveParamRefTuple(p.param, params);
          if (tuple === undefined) {
            // Param not yet set — treat as wildcard: consume remaining
            let remainingRequired = 0;
            for (let k = j + 1; k < pattern.length; k++) {
              if (pattern[k].kind !== "wildcard" && pattern[k].kind !== "param_spread") remainingRequired++;
            }
            const available = inputDims.length - i;
            const toConsume = Math.max(0, available - remainingRequired);
            for (let c = 0; c < toConsume; c++) {
              captured.push(inputDims[i]);
              i++;
            }
            j++;
            break;
          }
          // Consume exactly tuple.length dims
          for (let c = 0; c < tuple.length; c++) {
            if (i + c >= inputDims.length) {
              return {
                nodeId: "",
                message: `param_spread "${p.param}": expected ${tuple.length} dims but input has only ${inputDims.length - i} remaining`,
                severity: "error",
              } satisfies TypeError;
            }
          }
          // Push all consumed dims to captured
          for (let c = 0; c < tuple.length; c++) {
            captured.push(inputDims[i]);
            i++;
          }
          j++;
          break;
        }

        default:
          return {
            nodeId: "",
            message: `unknown pattern kind: ${(p as ShapeDimPattern).kind}`,
            severity: "error",
          } satisfies TypeError;
      }
    }

    // After pattern consumed, check no extra input dims remain
    if (i < inputDims.length) {
      return {
        nodeId: "",
        message: `expected ${pattern.length} dimensions in pattern, but input has ${inputDims.length} dims (extra dims at positions ${i}..${inputDims.length - 1})`,
        severity: "error",
      } satisfies TypeError;
    }

    return { success: true, bindings, captured };
  }

  /**
   * Resolve an output pattern to a concrete shape, substituting bindings
   * and captured wildcard dimensions.
   */
  private static resolvePattern(
    pattern: ShapePattern,
    params: Record<string, unknown>,
    env: TypeEnvironment,
    captured: ShapeDimension[],
  ): ShapeDimension[] {
    // Empty output pattern → terminal node (e.g. Loss nodes)
    if (pattern.length === 0) return [];

    const result: ShapeDimension[] = [];
    let capIdx = 0;

    for (const p of pattern) {
      switch (p.kind) {
        case "const":
          result.push({ kind: "const", value: p.value });
          break;

        case "symbolic": {
          const bound = env.get(p.name);
          if (bound !== undefined) {
            result.push(bound);
          } else {
            // Symbolic unbound — keep as symbolic (propagate)
            result.push({ kind: "symbolic", name: p.name });
          }
          break;
        }

        case "param_ref": {
          const val = this.resolveParamRef(p.name, params);
          if (val.status === 'resolved') {
            result.push({ kind: "const", value: val.value });
          } else {
            // unset or invalid — keep as symbolic (error already reported in patternMatch)
            result.push({ kind: "symbolic", name: `?${p.name}` });
          }
          break;
        }

        case "wildcard": {
          // Substitute all captured dimensions at this position
          while (capIdx < captured.length) {
            result.push(captured[capIdx]);
            capIdx++;
          }
          break;
        }

        case "computed": {
          // New path: expression-based computed dims
          if (p.expr) {
            try {
              // Build expression-friendly env: strip $/# prefixes so
              // $L resolves as "L" matching a #L binding from pattern match.
              const exprEnv = new Map<string, ShapeDimension>();
              for (const [key, dim] of env) {
                const bareName = key.replace(/^[#$]/, '');
                exprEnv.set(bareName, dim);
              }
              const context: EvalContext = {
                env: exprEnv,
                captured,
                params,
                resolveParam: (name: string) => {
                  const resolved = TypeEngine.resolveParamRef(name, params);
                  if (resolved.status === "resolved") return resolved.value;
                  return undefined;
                },
              };
              const ast = parseExpr(p.expr);
              const value = evaluate(ast, context);
              if (value !== undefined) {
                result.push({ kind: "const", value });
              } else {
                // Can't resolve all vars — keep as deferred computed
                result.push({ kind: "computed", expr: p.expr });
              }
            } catch (e) {
              if (e instanceof ParseError) {
                console.error(`Invalid expr in stereotype computed dim: ${e.message}`);
                // Keep as deferred computed dim (graceful degradation)
                result.push({ kind: "computed", expr: p.expr });
              } else {
                throw e;
              }
            }
          } else if (p.formula) {
            // LEGACY: old formula+args — keep as deferred computed
            // (no JSONs use this anymore; all migrated to expr)
            result.push({
              kind: "computed",
              formula: p.formula,
              args: p.args,
            });
          }
          break;
        }

        case "param_spread": {
          // Read tuple param, expand into N const dimensions
          const tuple = TypeEngine.resolveParamRefTuple(p.param, params);
          if (tuple !== undefined) {
            for (const v of tuple) {
              result.push({ kind: "const", value: v });
            }
          } else {
            // Unset — push symbolic placeholder
            result.push({ kind: "symbolic", name: `?${p.param}` });
          }
          break;
        }

        default:
          // Unknown pattern kind — keep as unknown symbolic
          result.push({
            kind: "symbolic",
            name: `?unknown_${(p as ShapeDimPattern).kind}`,
          });
          break;
      }
    }

    // Push any unconsumed captured dims only if the output pattern has a wildcard
    // to consume them (e.g. ReLU [*]).  For patterns without wildcards (e.g.
    // SequencePool [$B, $D]), captured dims are intentionally dropped.
    const hasWildcard = pattern.some(p => p.kind === "wildcard");
    if (hasWildcard) {
      while (capIdx < captured.length) {
        result.push(captured[capIdx]);
        capIdx++;
      }
    }

    return result;
  }

  /**
   * Extract a string parameter value from node params.
   *
   * Handles both flat values (`params[name] === "ij,jk->ik"`) and wrapped
   * objects (`params[name] === { value: "ij,jk->ik", position: "top" }`).
   *
   * Returns the string value, or `undefined` if the param is missing,
   * "None", "Undefined", or empty.
   */
  static extractParamString(
    name: string,
    params: Record<string, unknown>,
  ): string | undefined {
    const raw = params[name];
    if (raw === undefined || raw === null) return undefined;

    const val: unknown =
      typeof raw === "object" && raw !== null && "value" in raw
        ? (raw as Record<string, unknown>).value
        : raw;

    if (typeof val === "string") {
      if (val === "None" || val === "Undefined" || val === "") return undefined;
      return val;
    }
    return undefined;
  }

  /**
   * Infer output shape for an einsum join node.
   *
   * Parses the Einstein notation equation to determine the output shape
   * by mapping output labels to source dimensions from input tensors.
   *
   * 5-step algorithm:
   * 1. Parse equation string (split on "->", extract input label groups).
   * 2. Validate arity and ranks (must match).
   * 3. Determine output labels (explicit from RHS or implicit by counting).
   * 4. Map output labels to source dimensions (unify multi-input labels).
   * 5. Return output shape (and propagate dtype from first input).
   *
   * NOTE: Ellipsis ("...") is NOT supported — returns an error.
   */
  static inferEinsumShape(
    equation: string,
    inputTypes: TensorType[],
    stereotypeName: string,
  ): ShapeDimension[] | TypeError {
    // ── Early check: empty equation ────────────────────────────────
    if (!equation || equation.trim().length === 0) {
      return {
        nodeId: "",
        message: `"${stereotypeName}" equation is empty`,
        severity: "error",
      } satisfies TypeError;
    }

    // ── Step 1: Parse equation string ─────────────────────────────
    if (equation.includes("...")) {
      return {
        nodeId: "",
        message: "ellipsis not supported in type inference",
        severity: "error",
      } satisfies TypeError;
    }

    let lhs: string;
    let rhs: string | undefined;

    const arrowIdx = equation.indexOf("->");
    if (arrowIdx >= 0) {
      lhs = equation.slice(0, arrowIdx).trim();
      rhs = equation.slice(arrowIdx + 2).trim();
    } else {
      lhs = equation.trim();
      rhs = undefined;
    }

    const inputLabelStrs = lhs.split(",").map((s) => s.trim());

    // ── Step 2: Validate arity and ranks ─────────────────────────
    if (inputLabelStrs.length !== inputTypes.length) {
      return {
        nodeId: "",
        message: `"${stereotypeName}" equation expects ${inputLabelStrs.length} inputs but got ${inputTypes.length}`,
        severity: "error",
      } satisfies TypeError;
    }

    for (let k = 0; k < inputLabelStrs.length; k++) {
      const labelStr = inputLabelStrs[k];
      const tensor = inputTypes[k];
      if (labelStr.length !== tensor.shape.length) {
        return {
          nodeId: "",
          message: `"${stereotypeName}" input ${k} label group "${labelStr}" has ${labelStr.length} dims but input has ${tensor.shape.length} dims`,
          severity: "error",
        } satisfies TypeError;
      }
    }

    // ── Step 3: Determine output labels ─────────────────────────
    let outputLabelStr: string;
    if (rhs !== undefined) {
      outputLabelStr = rhs; // may be empty string → scalar output
    } else {
      // Implicit: labels appearing exactly once, sorted alphabetically
      const labelCounts = new Map<string, number>();
      for (const ls of inputLabelStrs) {
        for (const ch of ls) {
          labelCounts.set(ch, (labelCounts.get(ch) ?? 0) + 1);
        }
      }
      const onceLabels: string[] = [];
      for (const [label, count] of labelCounts) {
        if (count === 1) onceLabels.push(label);
      }
      onceLabels.sort();
      outputLabelStr = onceLabels.join("");
    }

    // ── Step 4: Unify every label occurrence ────────────────────
    // Contracted labels and repeated labels within one operand are just as
    // constrained as labels that survive in the output.
    const labelDimensions = new Map<string, ShapeDimension>();
    for (let k = 0; k < inputLabelStrs.length; k++) {
      const labelStr = inputLabelStrs[k];
      for (let p = 0; p < labelStr.length; p++) {
        const label = labelStr[p];
        const dimension = inputTypes[k].shape[p];
        const existing = labelDimensions.get(label);
        if (existing && !dimEqual(existing, dimension)) {
          return {
            nodeId: "",
            message: `"${stereotypeName}" label "${label}" bound to conflicting dimensions: ${this.describeDim(existing)} vs ${this.describeDim(dimension)}`,
            severity: "error",
          } satisfies TypeError;
        }
        if (!existing) labelDimensions.set(label, dimension);
      }
    }

    const outputLabels = [...outputLabelStr];
    if (new Set(outputLabels).size !== outputLabels.length) {
      return {
        nodeId: "",
        message: `"${stereotypeName}" output labels must be unique`,
        severity: "error",
      } satisfies TypeError;
    }

    const outputDims: ShapeDimension[] = [];
    for (const outputLabel of outputLabels) {
      const dimension = labelDimensions.get(outputLabel);
      if (!dimension) {
        return {
          nodeId: "",
          message: `"${stereotypeName}" label "${outputLabel}" in output not found in any input`,
          severity: "error",
        } satisfies TypeError;
      }
      outputDims.push(dimension);
    }

    // ── Step 5: Return output shape ──────────────────────────────
    return outputDims;
  }

  /**
   * Resolve a parameter reference from a node's parameter map.
   *
   * Handles both flat values (`params[name] === "784"`) and wrapped objects
   * (`params[name] === { value: "784", position: "top" }`).
   *
   * Returns a discriminated union:
   * - `{ status: 'unset' }` — parameter is "None" or truly missing
   * - `{ status: 'invalid', value }` — parameter has a non-numeric value ("Undefined", "", "cazz", etc.)
   * - `{ status: 'resolved', value }` — parameter resolved to a number
   */
  static resolveParamRef(
    name: string,
    params: Record<string, unknown>,
  ): ParamResolution {
    const raw = params[name];
    if (raw === undefined || raw === null) return { status: 'unset' };

    // Handle wrapped parameter objects: { value: "784", position: "top" }
    const val: unknown =
      typeof raw === "object" && raw !== null && "value" in raw
        ? (raw as Record<string, unknown>).value
        : raw;

    if (typeof val === "number") return { status: 'resolved', value: val };
    if (typeof val === "string") {
      if (val === "None" || val === "Undefined" || val === "") {
        return { status: 'unset' };
      }
      const parsed = Number(val);
      if (isNaN(parsed)) {
        return { status: 'invalid', value: val };
      }
      return { status: 'resolved', value: parsed };
    }
    return { status: 'unset' };
  }

  /**
   * Resolve a parameter reference as a tuple of numbers.
   *
   * Handles:
   * - number: [value]
   * - string "(1, 100)": [1, 100]
   * - string "1, 100": [1, 100]
   * - string "(1)": [1]
   * - string "1": [1]
   * - "Undefined", "", "None", missing: undefined
   */
  static resolveParamRefTuple(
    name: string,
    params: Record<string, unknown>,
  ): number[] | undefined {
    const raw = params[name];
    if (raw === undefined || raw === null) return undefined;

    const val: unknown =
      typeof raw === "object" && raw !== null && "value" in raw
        ? (raw as Record<string, unknown>).value
        : raw;

    if (typeof val === "number") return [val];
    if (typeof val === "string") {
      if (val === "None" || val === "Undefined" || val === "") return undefined;
      const cleaned = val.replace(/[()[\]]/g, "").trim();
      if (!cleaned) return undefined;
      const parts = cleaned.split(",").map(s => parseInt(s.trim(), 10));
      if (parts.some(isNaN)) return undefined;
      return parts;
    }
    return undefined;
  }

  /**
   * Evaluate an expression string with concrete values.
   * Used for testing — evaluates an expression with given symbolic env,
   * params, and captured dims, returning the numeric result or undefined.
   */
  static inferConcrete(
    expr: string,
    envValues: Record<string, number>,
    paramValues: Record<string, unknown>,
    capturedValues: number[],
  ): number | undefined {
    const env = new Map<string, ShapeDimension>();
    for (const [key, val] of Object.entries(envValues)) {
      env.set(key, { kind: "const", value: val });
    }
    const captured: ShapeDimension[] = capturedValues.map((v) => ({
      kind: "const" as const,
      value: v,
    }));
    const ast = parseExpr(expr);
    const ctx: EvalContext = {
      env,
      captured,
      params: paramValues,
      resolveParam: (name: string) => {
        const resolved = this.resolveParamRef(name, paramValues);
        if (resolved.status === "resolved") return resolved.value;
        return undefined;
      },
    };
    return evaluate(ast, ctx);
  }

  /**
   * Evaluate an advisory condition against the bound environment and params.
   *
   * Returns a TypeWarning if the condition fires, or null if it doesn't
   * (or if the condition can't be evaluated).
   *
   * Two evaluation strategies:
   * 1. Kernel_size vs spatial dims check (for Conv2d, Conv1d, MaxPool2d)
   * 2. Simple expression-style conditions (for Dropout p > 0.5, etc.)
   */
  static evaluateAdvisory(
    advisory: Advisory,
    env: TypeEnvironment,
    params: Record<string, unknown>,
    nodeId: string,
  ): TypeWarning | null {
    // ── Strategy 1: kernel_size vs spatial dimension check ──────────
    const ksize = TypeEngine.resolveParamRefTuple("kernel_size", params);
    if (ksize) {
      // Try multiple key variants: bare name (unit tests), #-prefixed (after rename),
      // $-prefixed (legacy). The env may use any of these depending on context.
      const hDim = env.get("H") ?? env.get("#H") ?? env.get("$H");
      const wDim = env.get("W") ?? env.get("#W") ?? env.get("$W");
      const lDim = env.get("L") ?? env.get("#L") ?? env.get("$L");
      const h = hDim?.kind === "const" ? hDim.value : undefined;
      const w = wDim?.kind === "const" ? wDim.value : undefined;
      const l = lDim?.kind === "const" ? lDim.value : undefined;

      let exceeds = false;
      if (ksize.length >= 1) {
        if (h !== undefined && ksize[0] > h) exceeds = true;
        if (l !== undefined && ksize[0] > l) exceeds = true;
      }
      if (ksize.length >= 2 && w !== undefined && ksize[1] > w) exceeds = true;

      if (exceeds) {
        return {
          nodeId,
          message: advisory.message,
          kind: advisory.kind,
        };
      }
      return null;
    }

    // ── Strategy 2: Simple param-based condition (e.g. Dropout p > 0.5) ──
    // Try evaluating the condition as a comparison between a param and a number.
    // Format expected: "param_name > N" or "param_name < N"
    const comparisonMatch = advisory.condition.match(
      /^(\w+)\s*(>|>=|<|<=)\s*([\d.]+)$/,
    );
    if (comparisonMatch) {
      const [, paramName, op, thresholdStr] = comparisonMatch;
      const threshold = parseFloat(thresholdStr);
      const resolved = TypeEngine.resolveParamRef(paramName, params);
      if (resolved.status === "resolved") {
        let fires = false;
        switch (op) {
          case ">":  fires = resolved.value > threshold; break;
          case ">=": fires = resolved.value >= threshold; break;
          case "<":  fires = resolved.value < threshold; break;
          case "<=": fires = resolved.value <= threshold; break;
        }
        if (fires) {
          return {
            nodeId,
            message: advisory.message,
            kind: advisory.kind,
          };
        }
      }
      return null;
    }

    // Unknown/unparseable condition — warn maintainers
    console.warn(
      `Unknown advisory condition pattern: "${advisory.condition}" — no strategy matched`,
    );
    return null;
  }

  /**
   * Human-readable dimension description for error messages.
   */
  static describeDim(d: ShapeDimension): string {
    switch (d.kind) {
      case "const":
        return String(d.value);
      case "symbolic":
        return `$${d.name}`;
      case "param_ref":
        return `params.${d.name}`;
      case "wildcard":
        return "*";
      case "computed":
        return d.expr ? `computed(${d.expr})` : `computed(${d.formula ?? "?"})`;
      case "param_spread":
        return d.values ? `[${d.values.join(",")}]` : `spread(${d.param})`;
    }
  }

  /** Compare join input handles by numeric suffix (`in-2` before `in-10`). */
  static compareTargetHandles(a: string, b: string): number {
    const aMatch = /^in-(\d+)$/.exec(a);
    const bMatch = /^in-(\d+)$/.exec(b);
    if (aMatch && bMatch) return Number(aMatch[1]) - Number(bMatch[1]);
    if (aMatch) return -1;
    if (bMatch) return 1;
    return a.localeCompare(b);
  }

  private static blockedByFromEdges(
    edges: Edge[],
    annotations: Map<string, NodeTypeAnnotation>,
  ): string[] {
    return [...new Set(
      edges.flatMap((edge) => annotations.get(edge.source)?.blockedBy ?? []),
    )];
  }

  private static blockedAnnotation(
    nodeId: string,
    blockedBy: string[],
  ): NodeTypeAnnotation {
    return {
      nodeId,
      outputType: { shape: [], dtype: "unknown" },
      blockedBy: [...new Set(blockedBy)],
    };
  }

  private static primaryErrorIds(errors: TypeError[]): string[] {
    return [...new Set(
      errors
        .filter((error) => error.severity === "error" && error.nodeId)
        .map((error) => error.nodeId),
    )];
  }

  private static dedupeErrors(errors: TypeError[]): TypeError[] {
    const seen = new Set<string>();
    return errors.filter((error) => {
      const key = `${error.nodeId}|${error.severity}|${error.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers (module-level, not exported)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if two dimensions are equal (same kind + same value/name).
 */
function dimEqual(a: ShapeDimension, b: ShapeDimension): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "const":
      return a.value === (b as typeof a).value;
    case "symbolic":
      return a.name === (b as typeof a).name;
    case "param_ref":
      return a.name === (b as typeof a).name;
    case "wildcard":
      return true;
    case "computed":
      return a.formula === (b as typeof a).formula && 
             JSON.stringify(a.args) === JSON.stringify((b as typeof a).args);
    case "param_spread":
      return a.param === (b as typeof a).param;
  }
}

/**
 * Type guard: is the value a TensorType (has `shape` property)?
 */
function isTensorType(
  value: TensorType | TypeError,
): value is TensorType {
  return "shape" in value;
}

/**
 * Type guard: is the value a TypeError?
 */
function isTypeError(
  value: PatternMatchResult | TypeError,
): value is TypeError {
  return !("success" in value);
}

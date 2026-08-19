import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { StereotypeCore, type StereotypeJson } from "../core/StereotypeCore";
import { evaluateSignature } from "../type-system/signatureEvaluator";

const source = (relative: string) => readFileSync(resolve(process.cwd(), relative), "utf8");
const parse = (relative: string) => ts.createSourceFile(relative, source(relative), ts.ScriptTarget.Latest, true);
const imports = (file: ts.SourceFile) => file.statements.flatMap(statement => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) ? [statement.moduleSpecifier.text] : []);
const propertyNames = (file: ts.SourceFile): string[] => {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isPropertyAccessExpression(node) || ts.isPropertyAssignment(node) || ts.isPropertySignature(node)) && ts.isIdentifier(node.name)) names.push(node.name.text);
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) names.push(node.argumentExpression.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
};
const tensor = (shape: number[], dtype = "float32") => ({ shape, dtype });
const stereotype = (type_signature: unknown, params: StereotypeJson["params"] = {}): StereotypeJson => ({ params, type_signature });
const v2 = (overrides: Record<string, unknown> = {}) => ({ version: 2, inputs: [], output: { kind: "pattern", dims: [] }, to_dtype: "float32", ...overrides });

describe("generic type architecture", () => {
  it("keeps the generic evaluator independent of StereotypeCore and graph state", () => {
    const file = parse("src/type-system/signatureEvaluator.ts");
    const dependencies = imports(file);
    expect(dependencies.some(dependency => /(?:StereotypeCore|DiagramCore|scopeGraph|conversion\/typeEngine)/.test(dependency))).toBe(false);
  });

  it("rejects legacy schema/action vocabulary through AST declarations and property use", () => {
    const files = ["src/conversion/typeEngine.ts", "src/type-system/model.ts", "src/type-system/schema.ts", "src/type-system/signatureEvaluator.ts", "src/type-system/subflowEvaluator.ts"];
    const forbidden = new Set(["action", "infer_then_transform", "last_dim", "dim_expr", "einsum_param"]);
    for (const file of files) expect(propertyNames(parse(file)).filter(name => forbidden.has(name))).toEqual([]);
  });

  it("rejects ordinary stereotype-name literals and permits lowercase einsum only as a shape kind", () => {
    const files = ["src/conversion/typeEngine.ts", "src/type-system/model.ts", "src/type-system/schema.ts", "src/type-system/signatureEvaluator.ts", "src/type-system/subflowEvaluator.ts"];
    const ordinaryNames = new Set(["Addition", "Concat", "HorizontalRepeat", "Repeat", "MatMul", "Einsum"]);
    for (const relative of files) {
      const file = parse(relative);
      const invalid: string[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteral(node) && ordinaryNames.has(node.text)) invalid.push(`${relative}:${node.getText(file)}`);
        if (ts.isStringLiteral(node) && node.text === "einsum" && isEinsumSemanticUse(node) && !isShapeKind(node)) invalid.push(`${relative}:${node.getText(file)}`);
        ts.forEachChild(node, visit);
      };
      visit(file);
      expect(invalid).toEqual([]);
    }
  });

  it("evaluates a never-before-seen declaration through the loader and generic evaluator", () => {
    const loaded = new StereotypeCore("/NovelProjection.json", stereotype(v2({
      inputs: [{ lower: 1, upper: 1, pattern: { kind: "pattern", dims: [{ kind: "wildcard" }] } }],
      output: { kind: "computed_shape", expr: "replace(shape(input(0, 0)), -1, dim(input(0, 0), -1) + param.extra)" },
      to_dtype: "dtype(input(0, 0))",
    }), { extra: { type: "int", default: "7" } }));
    expect(loaded.typeSignature).toBeDefined();
    expect(evaluateSignature(loaded.typeSignature!, [tensor([2, 3])], { extra: { status: "resolved", value: 7 } })).toMatchObject({ ok: true, output: { shape: [2, 10], dtype: "float32" } });
  });

  it("selects Einsum by output discriminant, not the stereotype name", () => {
    const loaded = new StereotypeCore("/RenamedContraction.json", stereotype(v2({
      inputs: [{ lower: 2, upper: 2, pattern: { kind: "pattern", dims: [{ kind: "wildcard" }] } }],
      output: { kind: "einsum", equation: { parameter: "equation" } },
      to_dtype: "float32",
    }), { equation: { type: "str", default: "bij,bjk->bik" } }));
    const parameters = { equation: { status: "resolved" as const, value: "bij,bjk->bik" } };
    expect(evaluateSignature(loaded.typeSignature!, [tensor([2, 3, 4]), tensor([2, 4, 5])], parameters)).toMatchObject({ ok: true, output: { shape: [2, 3, 5] } });
  });

  it("does not mistake a renamed ordinary declaration for Einsum", () => {
    const loaded = new StereotypeCore("/Einsum.json", stereotype(v2({
      inputs: [{ lower: 1, upper: 1, pattern: { kind: "pattern", dims: [{ kind: "wildcard" }] } }],
      output: { kind: "pattern", dims: [{ kind: "wildcard" }] },
      to_dtype: "float32",
    })));
    expect(evaluateSignature(loaded.typeSignature!, [tensor([2, 3])], {})).toMatchObject({ ok: true, output: { shape: [2, 3] } });
  });
});

function isShapeKind(node: ts.StringLiteral): boolean {
  const parent = node.parent;
  if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name) && parent.name.text === "kind") return true;
  if (!ts.isBinaryExpression(parent) || parent.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return false;
  return [parent.left, parent.right].some(side => ts.isPropertyAccessExpression(side) && side.name.text === "kind");
}

function isEinsumSemanticUse(node: ts.StringLiteral): boolean {
  return ts.isBinaryExpression(node.parent);
}

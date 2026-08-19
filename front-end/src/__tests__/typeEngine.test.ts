import { afterAll, describe, expect, it } from "vitest";
import { Diagram } from "../Diagram.svelte";
import { TypeEngine } from "../conversion/typeEngine";
import { serializeTypeResult } from "../conversion/typeDiagnostics";
import { edge, stubWindow, unstubWindow } from "./helpers";

stubWindow();
afterAll(() => unstubWindow());

function stereotype(diagram: Diagram, name: string) {
  const value = diagram.stereotypes.find(candidate => candidate.name === name);
  if (!value) throw new Error(`missing stereotype ${name}`);
  return value;
}

describe("TypeEngine v2 production adapter", () => {
  it("uses compiled declarations for a normal graph and keeps RPC annotations stable", () => {
    const diagram = new Diagram();
    const input = diagram.nodes[0];
    diagram.updateModule(input.id, { params: { out_features: { value: "784" } } });
    diagram.addModule(stereotype(diagram, "Linear"), 100, 0, {
      params: { in_features: "784", out_features: "10" },
    });
    const linear = diagram.nodes[1];
    diagram.edges = [edge("input-linear", input.id, linear.id)];

    const result = TypeEngine.infer(diagram);
    expect(result.ok).toBe(true);
    expect(result.annotations.get(linear.id)?.outputType.shape).toEqual([
      { kind: "symbolic", name: "B" },
      { kind: "const", value: 10 },
    ]);
    expect(serializeTypeResult(result).annotations[linear.id].outputType.dtype).toBe("float32");
  });

  it("orders join inputs by numeric target handle and evaluates a variadic v2 group", () => {
    const diagram = new Diagram();
    const source = diagram.nodes[0];
    diagram.updateModule(source.id, { params: { out_features: { value: "4" } } });
    const fork = stereotype(diagram, "Fork");
    for (let index = 0; index < 3; index += 1) diagram.addModule(fork, 100, index * 80);
    diagram.addJoinNode(stereotype(diagram, "Addition"), 300, 0);
    const join = diagram.nodes.at(-1)!;
    diagram.edges = [
      edge("a", source.id, diagram.nodes[3].id),
      edge("b", source.id, diagram.nodes[1].id),
      edge("c", source.id, diagram.nodes[2].id),
      edge("j10", diagram.nodes[1].id, join.id, { targetHandle: "in-10" }),
      edge("j2", diagram.nodes[2].id, join.id, { targetHandle: "in-2" }),
      edge("j0", diagram.nodes[3].id, join.id, { targetHandle: "in-0" }),
    ];

    const result = TypeEngine.infer(diagram);
    expect(result.ok).toBe(true);
    expect(result.annotations.get(join.id)?.inputTypes).toHaveLength(3);
    expect(result.annotations.get(join.id)?.outputType.shape).toEqual([
      { kind: "symbolic", name: "B" },
      { kind: "const", value: 4 },
    ]);
  });

  it("records one primary failure and blocks downstream nodes", () => {
    const diagram = new Diagram();
    const input = diagram.nodes[0];
    diagram.updateModule(input.id, { params: { out_features: { value: "4" } } });
    diagram.addModule(stereotype(diagram, "Linear"), 100, 0, {
      params: { in_features: "5", out_features: "2" },
    });
    diagram.addModule(stereotype(diagram, "ReLU"), 200, 0);
    const linear = diagram.nodes[1];
    const relu = diagram.nodes[2];
    diagram.edges = [edge("input-linear", input.id, linear.id), edge("linear-relu", linear.id, relu.id)];

    const result = TypeEngine.infer(diagram);
    expect(result.ok).toBe(false);
    expect(result.errors.filter(error => error.nodeId === linear.id)).toHaveLength(1);
    expect(result.errors.filter(error => error.nodeId === relu.id)).toHaveLength(1);
    expect(result.annotations.get(relu.id)?.blockedBy).toEqual([linear.id]);
    expect(result.annotations.get(relu.id)?.outputType.dtype).toBe("unknown");
  });

  it("normalizes an anonymous subflow through its internal graph", () => {
    const diagram = new Diagram();
    const source = diagram.nodes[0];
    diagram.updateModule(source.id, { params: { out_features: { value: "4" } } });
    const container = diagram.addSubGraph(100, 0);
    diagram.addModule(stereotype(diagram, "Input"), 0, 0, {
      parentId: container.id,
      params: { out_features: "4" },
    });
    const internalInput = diagram.nodes.at(-1)!;
    diagram.addModule(stereotype(diagram, "Linear"), 80, 0, {
      parentId: container.id,
      params: { in_features: "4", out_features: "2" },
    });
    const internalLinear = diagram.nodes.at(-1)!;
    diagram.edges = [
      edge("outer", source.id, container.id),
      edge("inner", internalInput.id, internalLinear.id),
    ];

    const result = TypeEngine.infer(diagram);
    expect(result.ok).toBe(true);
    expect(result.annotations.get(container.id)?.outputType).toEqual({
      shape: [{ kind: "symbolic", name: "B" }, { kind: "const", value: 2 }],
      dtype: "float32",
    });
  });

  it("rejects graph cycles without attempting inference", () => {
    const diagram = new Diagram();
    const input = diagram.nodes[0];
    diagram.addModule(stereotype(diagram, "ReLU"), 100, 0);
    const relu = diagram.nodes[1];
    diagram.edges = [edge("forward", input.id, relu.id), edge("back", relu.id, input.id)];

    const result = TypeEngine.infer(diagram);
    expect(result.ok).toBe(false);
    expect(result.errors.map(error => error.nodeId)).toEqual(expect.arrayContaining([input.id, relu.id]));
    expect(result.annotations.get(relu.id)?.blockedBy).toEqual(expect.arrayContaining([input.id, relu.id]));
  });

  it("distinguishes a cycle from its blocked dependent", () => {
    const diagram = new Diagram();
    const input = diagram.nodes[0];
    diagram.addModule(stereotype(diagram, "ReLU"), 100, 0);
    diagram.addModule(stereotype(diagram, "ReLU"), 200, 0);
    const cycle = diagram.nodes[1];
    const dependent = diagram.nodes[2];
    diagram.edges = [edge("forward", input.id, cycle.id), edge("back", cycle.id, input.id), edge("dependent", cycle.id, dependent.id)];

    const result = TypeEngine.infer(diagram);
    expect(result.errors.find(error => error.nodeId === dependent.id)?.message).toContain("blocked by a graph cycle");
    expect(result.annotations.get(dependent.id)?.blockedBy).toEqual([cycle.id]);
  });
});

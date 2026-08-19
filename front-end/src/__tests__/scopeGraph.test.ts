import { describe, expect, it } from "vitest";
import { describeScopeGraph } from "../core/scopeGraph";
import { edge, node } from "./helpers";

describe("scope graph", () => {
  it("describes a single-boundary DAG with target-handle predecessor order", () => {
    const nodes = [node("entry", "Input", "entry"), node("left", "ReLU", "left"), node("right", "ReLU", "right"), node("join", "Addition", "join")];
    const graph = describeScopeGraph(nodes, [edge("a", "entry", "left"), edge("b", "entry", "right"), edge("c", "right", "join", { targetHandle: "in-1" }), edge("d", "left", "join", { targetHandle: "in-0" })], { isEntry: (candidate) => candidate.id === "entry" });
    expect(graph.entryId).toBe("entry");
    expect(graph.exitId).toBe("join");
    expect(graph.predecessors.get("join")).toEqual(["left", "right"]);
    expect(graph.topologicalOrder).toEqual(["entry", "left", "right", "join"]);
  });

  it("rejects ambiguous boundaries and cycles", () => {
    expect(() => describeScopeGraph([node("a", "ReLU", "a"), node("b", "ReLU", "b")], [])).toThrow("exactly one entry");
    expect(() => describeScopeGraph([node("a", "ReLU", "a"), node("b", "ReLU", "b")], [edge("ab", "a", "b"), edge("ba", "b", "a")])).toThrow("cycle");
  });

  it("does not let a declared entry hide another structural source", () => {
    const nodes = [node("entry", "Input", "entry"), node("extra", "ReLU", "extra"), node("exit", "Addition", "exit")];
    expect(() => describeScopeGraph(nodes, [edge("a", "entry", "exit"), edge("b", "extra", "exit")], { isEntry: (candidate) => candidate.id === "entry" })).toThrow("exactly one entry");
  });
});

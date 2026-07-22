import { describe, expect, it, vi } from "vitest";
import type { Node } from "@xyflow/svelte";
import { Diagram } from "../Diagram.svelte";
import { NNTree } from "../conversion/nnTree";
import { BrowserRPCHandler } from "../sync/BrowserRPCHandler";
import { StereotypeCore } from "../core/StereotypeCore";
import { stubWindow, unstubWindow, node, edge } from "./helpers";

describe("Observable nodes", () => {
  it("creates a passive node and rejects it as an edge source", () => {
    stubWindow();
    const diagram = new Diagram();
    const recorder = diagram.getStereotype("ActivationRecorder");
    expect(recorder?.isObservable).toBe(true);
    expect(recorder).toBeDefined();
    diagram.nodes = [node("input", "Input", "Input", {}, { isInput: true })];
    diagram.addModule(recorder!, 0, 0);
    const observable = diagram.nodes[1];
    expect(observable.type).toBe("observable");
    expect(observable.data.isObservable).toBe(true);
    expect(observable.data.params.execution_modes).toBeDefined();
    diagram.edges = [];
    expect(diagram.checkValidConnection(observable.id, "input", "out", "in")).toBe(false);
    expect(() => diagram.addEdge("input", observable.id, "out", "not-a-handle")).toThrow("Unknown Observable target handle");
    const edge = diagram.addEdge("input", observable.id, "out", "in-0");
    expect(() => diagram.reconnectEdge(edge.id, observable.id, "input")).toThrow("Observable nodes cannot be connection sources");
    expect(diagram.undo()).toBe(true);
    const exported = diagram.exportToJson();
    const imported = new Diagram();
    expect(imported.importFromJson(exported)).toBe(true);
    expect(imported.nodes.find((candidate) => candidate.type === "observable")?.data.isObservable).toBe(true);
    unstubWindow();
  });

  it("creates an Observable through the BrowserRPCHandler path", () => {
    stubWindow();
    const diagram = new Diagram();
    const mockSend = vi.fn();
    const handler = new BrowserRPCHandler(diagram, "ws://localhost:0");
    Object.defineProperty(handler, "ws", { value: { send: mockSend, readyState: 1 }, writable: true });
    const receive = handler as unknown as { handleMessage(event: { data: string }): void };
    receive.handleMessage({ data: JSON.stringify({ id: "create", method: "create_node", params: { stereotype: "ActivationStatistics" } }) });
    const response = JSON.parse(String(mockSend.mock.calls[0][0]));
    const created = diagram.getNodeById(response.result.nodeId);
    expect(created?.type).toBe("observable");
    expect(created?.data.isObservable).toBe(true);
    expect(diagram.checkValidConnection(created!.id, diagram.nodes[0].id, "out", "in")).toBe(false);
    mockSend.mockClear();
    receive.handleMessage({ data: JSON.stringify({ id: "connect", method: "connect_nodes", params: { source: diagram.nodes[0].id, target: created!.id, targetHandle: "in-0" } }) });
    expect(JSON.parse(String(mockSend.mock.calls[0][0])).error).toBeUndefined();
    mockSend.mockClear();
    receive.handleMessage({ data: JSON.stringify({ id: "reject", method: "connect_nodes", params: { source: created!.id, target: diagram.nodes[0].id } }) });
    expect(JSON.parse(String(mockSend.mock.calls[0][0])).error.message).toContain("Observable nodes cannot be connection sources");
    unstubWindow();
  });

  it("keeps observation edges out of the model and emits ordered interpretability inputs", () => {
    stubWindow();
    const diagram = new Diagram();
    const nodes: Node[] = [
      node("input", "Input", "Input", {}, { isInput: true }),
      node("linear", "Linear", "Linear", { in_features: { value: "4" }, out_features: { value: "3" }}),
      node("loss", "MSELoss", "Loss", {}, { isLoss: true }),
      node("obs", "ActivationRecorder", "Recorder", {}, { type: "observable" }),
    ];
    nodes[3].data.isObservable = true;
    diagram.nodes = nodes;
    diagram.edges = [
      edge("model", "input", "linear"),
      edge("loss", "linear", "loss"),
      edge("observe", "linear", "obs", { targetHandle: "in-0" }),
    ];
    const compiled = JSON.parse(new NNTree(diagram).toJson()) as {
      nodes: Record<string, { data: { layers?: Array<{ moduleId?: string }> } }>;
      interpretability: { observables: Record<string, { inputs: Array<{ targetHandle: string; sourceNodeId: string }> }> };
    };
    expect(JSON.stringify(compiled.nodes)).not.toContain("obs");
    expect(compiled.nodes.input.data.layers?.map((layer) => layer.moduleId)).toContain("linear");
    expect(compiled.interpretability.observables.obs.inputs).toEqual([
      { targetHandle: "in-0", sourceNodeId: "linear", sourcePoint: "out" },
    ]);
    unstubWindow();
  });

  it("annotates Observable inputs without producing an output type", () => {
    stubWindow();
    const diagram = new Diagram();
    const nodes: Node[] = [
      node("input", "Input", "Input", {}, { isInput: true }),
      node("obs", "ActivationStatistics", "Stats", {}, { type: "observable" }),
    ];
    nodes[1].data.isObservable = true;
    diagram.nodes = nodes;
    diagram.edges = [edge("observe", "input", "obs", { targetHandle: "in-0" })];
    const result = diagram.refreshTypes();
    const annotation = result.annotations.get("obs");
    expect(annotation?.inputTypes).toHaveLength(1);
    expect(annotation?.outputType).toBeUndefined();
    expect(result.ok).toBe(true);
    unstubWindow();
  });

  it("keeps malformed observation-source edges out of the model and preserves failed imports", () => {
    stubWindow();
    const diagram = new Diagram();
    const originalNodes = diagram.nodes;
    const imported = {
      nodes: [
        node("input", "Input", "Input", { out_features: { value: "784" } }, { isInput: true }),
        node("obs", "ActivationRecorder", "Recorder", {}, { type: "observable" }),
      ],
      edges: [edge("bad", "obs", "input")],
    };
    imported.nodes[1].data.isObservable = true;
    expect(diagram.importFromJson(JSON.stringify(imported))).toBe(false);
    expect(diagram.nodes).toBe(originalNodes);

    diagram.nodes = imported.nodes;
    diagram.nodes.push(node("loss", "MSELoss", "Loss", {}, { isLoss: true }));
    diagram.edges = [edge("model", "input", "loss"), edge("cycle-1", "input", "obs"), edge("cycle-2", "obs", "input")];
    const result = diagram.refreshTypes();
    expect(result.errors.some((error) => error.message.includes("cycle"))).toBe(false);
    expect(() => new NNTree(diagram).toJson()).not.toThrow();
    unstubWindow();
  });

  it("rejects an Observable structure with a computational stereotype before mutation", () => {
    stubWindow();
    const diagram = new Diagram();
    const originalNodes = diagram.nodes;
    const originalEdges = diagram.edges;
    const imported = {
      nodes: [
        node("input", "Input", "Input", {}, { isInput: true }),
        node("linear", "Linear", "Linear", {
          in_features: { value: "4" },
          out_features: { value: "3" },
        }, { type: "observable", isObservable: true }),
      ],
      edges: [edge("input-linear", "input", "linear")],
    };

    expect(diagram.importFromJson(JSON.stringify(imported))).toBe(false);
    expect(diagram.nodes).toBe(originalNodes);
    expect(diagram.edges).toBe(originalEdges);
    unstubWindow();
  });

  it("rejects a computational structure with an Observable stereotype before mutation", () => {
    stubWindow();
    const diagram = new Diagram();
    const originalNodes = diagram.nodes;
    const imported = {
      nodes: [
        node("input", "Input", "Input", {}, { isInput: true }),
        node("recorder", "ActivationRecorder", "Recorder", {}, { type: "custom" }),
      ],
      edges: [edge("input-recorder", "input", "recorder")],
    };

    expect(diagram.importFromJson(JSON.stringify(imported))).toBe(false);
    expect(diagram.nodes).toBe(originalNodes);
    unstubWindow();
  });

  it("keeps a structurally Observable computational stereotype in traversal", () => {
    stubWindow();
    const diagram = new Diagram();
    diagram.nodes = [
      node("input", "Input", "Input", {}, { isInput: true }),
      node("linear", "Linear", "Linear", {
        in_features: { value: "4" },
        out_features: { value: "3" },
      }, { type: "observable", isObservable: true }),
      node("loss", "MSELoss", "Loss", {}, { isLoss: true }),
    ];
    diagram.edges = [edge("input-linear", "input", "linear"), edge("linear-loss", "linear", "loss")];

    const compiled = JSON.parse(new NNTree(diagram).toJson()) as {
      nodes: Record<string, { data?: { layers?: Array<{ moduleId?: string }> } }>;
    };
    const result = diagram.refreshTypes();
    expect(compiled.nodes.input.data?.layers?.some((layer) => layer.moduleId === "linear")).toBe(true);
    expect(result.annotations.get("linear")?.outputType).toBeDefined();
    expect(result.errors.some((error) => error.nodeId === "linear" && error.message.includes("does not match"))).toBe(true);
    unstubWindow();
  });

  it("reports source points and duplicate fixed handles on the Observable", () => {
    stubWindow();
    const diagram = new Diagram();
    diagram.nodes = [
      node("input", "Input", "Input", {}, { isInput: true }),
      node("loss", "MSELoss", "Loss", {}, { isLoss: true }),
      node("obs", "ActivationRecorder", "Recorder", {}, { type: "observable" }),
    ];
    diagram.nodes[2].data.isObservable = true;
    diagram.edges = [
      edge("model", "input", "loss"),
      edge("one", "input", "obs", { sourceHandle: "hidden", targetHandle: "in-0" }),
      edge("two", "input", "obs", { targetHandle: "in-0" }),
    ];
    const result = diagram.refreshTypes();
    expect(result.errors.filter((error) => error.nodeId === "obs").map((error) => error.message).join(" ")).toContain("Unknown source point");
    expect(result.errors.filter((error) => error.nodeId === "obs").map((error) => error.message).join(" ")).toContain("exactly one connection");
    const compiled = JSON.parse(new NNTree(diagram).toJson());
    expect(compiled.interpretability.observables.obs.enabled).toBe(false);
    unstubWindow();
  });

  it("orders multiple Observable inputs by target handle rather than edge order", () => {
    stubWindow();
    const diagram = new Diagram();
    const comparison = new StereotypeCore("Observables/Comparison.json", {
      category: "Observable",
      pythonClassName: "interpretability.Comparison",
      observable: {
        captureKind: "FORWARD_VALUE",
        supportedModes: ["EVAL"],
        finalizePhase: "POST_RUN",
        defaultRetentionScope: "RUN",
        supportedRetentionScopes: ["RUN"],
        defaultStorageStrategy: "STREAMING",
        supportedStorageStrategies: ["STREAMING"],
        inputs: [
          { id: "in-0", label: "left", required: true },
          { id: "in-1", label: "right", required: true },
        ],
        resultSchema: { kind: "scalar" },
      },
      type_signature: {
        kind: "observable",
        input: [[{ kind: "wildcard" }], [{ kind: "wildcard" }]],
      },
    });
    diagram.initStereotypes([...diagram.stereotypes, comparison]);
    diagram.nodes = [
      node("input", "Input", "Input", {}, { isInput: true }),
      node("loss", "MSELoss", "Loss", {}, { isLoss: true }),
      node("obs", "Comparison", "Comparison", {}, { type: "observable" }),
    ];
    diagram.nodes[2].data.isObservable = true;
    diagram.edges = [
      edge("model", "input", "loss"),
      edge("right", "input", "obs", { targetHandle: "in-1" }),
      edge("left", "input", "obs", { targetHandle: "in-0" }),
    ];
    const compiled = JSON.parse(new NNTree(diagram).toJson());
    expect(compiled.interpretability.observables.obs.inputs.map((input: { targetHandle: string }) => input.targetHandle)).toEqual(["in-0", "in-1"]);
    unstubWindow();
  });

  it("does not let an invalid disabled Observable block computational conversion", () => {
    stubWindow();
    const diagram = new Diagram();
    diagram.nodes = [
      node("input", "Input", "Input", {}, { isInput: true }),
      node("loss", "MSELoss", "Loss", {}, { isLoss: true }),
      node("obs", "ActivationStatistics", "Stats", {}, { type: "observable" }),
    ];
    diagram.nodes[2].data.isObservable = true;
    diagram.nodes[2].data.enabled = false;
    diagram.edges = [edge("model", "input", "loss"), edge("invalid", "input", "obs", { targetHandle: "unknown" })];
    const result = diagram.refreshTypes();
    expect(result.ok).toBe(true);
    expect(result.errors.some((error) => error.nodeId === "obs")).toBe(true);
    expect(() => new NNTree(diagram).toJson()).not.toThrow();
    unstubWindow();
  });

  it("ignores malformed Observable-to-Linear edges in computational inference", () => {
    stubWindow();
    const makeDiagram = (withMalformedEdge: boolean): Diagram => {
      const diagram = new Diagram();
      diagram.nodes = [
        node("input", "Input", "Input", { out_features: { value: "784" } }, { isInput: true }),
        node("linear", "Linear", "Linear", { in_features: { value: "784" }, out_features: { value: "10" } }),
        node("loss", "MSELoss", "Loss", {}, { isLoss: true }),
        node("obs", "ActivationRecorder", "Recorder", {}, { type: "observable" }),
      ];
      diagram.nodes[3].data.isObservable = true;
      diagram.edges = [
        edge("input-linear", "input", "linear"),
        edge("linear-loss", "linear", "loss"),
        edge("input-obs", "input", "obs", { targetHandle: "in-0" }),
      ];
      if (withMalformedEdge) diagram.edges.push(edge("obs-linear", "obs", "linear"));
      return diagram;
    };
    const baseline = makeDiagram(false);
    const malformed = makeDiagram(true);
    const baselineResult = baseline.refreshTypes();
    const malformedResult = malformed.refreshTypes();
    expect(malformedResult.ok).toBe(baselineResult.ok);
    expect(malformedResult.annotations.get("linear")).toEqual(baselineResult.annotations.get("linear"));
    expect(malformedResult.errors.some((error) => error.nodeId === "obs" && error.message.includes("cannot feed computational"))).toBe(true);
    expect(malformedResult.errors.some((error) => error.nodeId === "linear")).toBe(false);
    unstubWindow();
  });
});

/*
 * NNModelling — DSL for designing neural networks via visual node editor
 * Copyright (C) 2026  Luca Sforza
 *
 * Licensed under the GNU General Public License v3 or later.
 * Commercial licenses are available — contact Luca Sforza.
 * See the LICENSE file for details.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 */

import type { DiagramCore } from "../core/DiagramCore";
import { findDirectedCycle } from "../core/validation";
import { describeScopeGraph, orderPredecessors } from "../core/scopeGraph";
import { type Edge, type Node } from "@xyflow/svelte";

export class NNTree {
  public nodes: Map<string, NNTreeNode>;
  public root: string;
  public lossNode: ModuleData | null = null;
  /** Visual IDs mapped to the runtime node that produces their value. */
  private readonly runtimeProducerByVisualId = new Map<string, string>();

  constructor(diagram: DiagramCore) {
    this.nodes = new Map();
    const inputNodes: Node[] = diagram.nodes.filter(
      n => n.parentId == null && n.data.stereotype === "Input",
    );
    if (inputNodes.length !== 1) {
      throw new Error("Expected exactly one input node, but found " + inputNodes.length);
    }
    // Defense in depth: the editor validation rejects cycle-forming edges, but
    // an imported diagram can still contain a directed cycle. Reject it here
    // independently of the traversal below. Subflow-internal edges are
    // validated by compileSubflowGraph (Kahn's topological sort) so the
    // subflow-specific error message is preserved.
    this.assertTopLevelAcyclic(diagram);
    let new_root = this.processNode(inputNodes[0], diagram, new Set());
    if (new_root === undefined) throw new Error("root is undefined");
    this.root = new_root;
    this.resolveTopLevelJoinInputs(diagram);
  }

  /**
   * Throw when the top-level graph (all nodes, edges that are not internal to
   * a single subflow) contains a directed cycle.
   */
  private assertTopLevelAcyclic(diagram: DiagramCore): void {
    const parentByNodeId = new Map<string, string | null | undefined>();
    for (const n of diagram.nodes) parentByNodeId.set(n.id, n.parentId);

    const isInternalToSameSubflow = (e: { source: string; target: string }): boolean => {
      const parent = parentByNodeId.get(e.source);
      return parent != null && parent === parentByNodeId.get(e.target);
    };

    const topLevelEdges = diagram.edges.filter((e) => !isInternalToSameSubflow(e));
    const cycle = findDirectedCycle(
      diagram.nodes.map((n) => n.id),
      topLevelEdges,
    );
    if (cycle) {
      throw new Error(`Graph contains a directed cycle: ${cycle.join(" -> ")}`);
    }
  }

  private getPythonClassName(diagram: DiagramCore, node: Node): string {
    const stereo = diagram.getStereotype(node.data.stereotype as string);
    return stereo?.pythonClassName || "";
  }

  private getTaskType(diagram: DiagramCore, node: Node): string {
    const stereo = diagram.getStereotype(node.data.stereotype as string);
    return stereo?.taskType || "";
  }

  private isSubflowNode(node: Node): boolean {
    return node.type === "subflow";
  }

  private nodeToModule(node: Node, diagram: DiagramCore): ModuleData {
    return {
      type: "module",
      name: node.data.name,
      stereotype: node.data.stereotype,
      pythonClassName: this.getPythonClassName(diagram, node),
      params: node.data.params,
    } as ModuleData;
  }

  /**
   * Replace visual producers in top-level joins with the runtime node IDs
   * emitted after sequential segments have been compacted.
   */
  private resolveTopLevelJoinInputs(diagram: DiagramCore): void {
    for (const [id, treeNode] of this.nodes) {
      const visualNode = diagram.getNodeById(id);
      if (treeNode.data.type !== "join" || visualNode?.parentId != null) continue;

      const inputs = orderPredecessors(diagram.edges, id)
        .filter((sourceId) => {
          const source = diagram.getNodeById(sourceId);
          const stereotype = source
            ? diagram.getStereotype(source.data.stereotype as string)
            : undefined;
          return !stereotype?.isLoss;
        })
        .map((sourceId) => this.runtimeProducerByVisualId.get(sourceId) ?? sourceId);

      treeNode.data = { ...treeNode.data, inputs };
    }
  }

  private compileSubflowGraph(diagram: DiagramCore, subflowId: string): SubflowGraph {
    const internalNodes = diagram.nodes.filter((n: any) => n.parentId === subflowId);
    if (internalNodes.length === 0) {
      console.warn("Subflow " + subflowId + " has no internal nodes");
      return { entryNode: "", nodes: {} };
    }
    const internalIds = new Set(internalNodes.map((n: any) => n.id));
    const internalEdges = diagram.edges.filter((e: any) =>
      internalIds.has(e.source) && internalIds.has(e.target),
    );

    const scope = describeScopeGraph(internalNodes, internalEdges, {
      isEntry: (candidate) => diagram.getStereotype((candidate.data as Record<string, unknown>).stereotype as string)?.isInput ?? false,
    });

    const nodesMap: Record<string, InternalNodeData> = {};

    for (const id of scope.topologicalOrder) {
      const n = internalNodes.find((m: any) => m.id === id)!;
      const children = [...(scope.successors.get(id) ?? [])];

      const nd = n.data as Record<string, unknown>;
      if (this.isSubflowNode(n)) {
        const nested = this.compileSubflowGraph(diagram, n.id);
        nodesMap[id] = {
          type: "subflow",
          name: nd.name as string,
          stereotype: nd.stereotype as string,
          pythonClassName: this.getPythonClassName(diagram, n),
          params: nd.params,
          children,
          entryNode: nested.entryNode,
          nodes: nested.nodes,
        };
      } else {
        const isJoinNode = n.type === "join"
          || diagram.getStereotype(nd.stereotype as string)?.category === "Join";
        nodesMap[id] = {
          type: isJoinNode ? "join" : "module",
          name: nd.name as string,
          stereotype: nd.stereotype as string,
          pythonClassName: this.getPythonClassName(diagram, n),
          taskType: this.getTaskType(diagram, n),
          params: nd.params,
          children,
          ...(isJoinNode ? { inputs: [...(scope.predecessors.get(id) ?? [])] } : {}),
        };
      }
    }

    return { entryNode: scope.entryId, nodes: nodesMap };
  }

  private processSubflow(node: Node, diagram: DiagramCore, visited: Set<string>): string {
    const graph = this.compileSubflowGraph(diagram, node.id);

    const outerChilds = diagram.getChilds(node.id);
    const nextNodes: string[] = [];
    for (const child of outerChilds) {
      const nnNode = this.processNode(child, diagram, visited);
      if (nnNode !== undefined) nextNodes.push(nnNode);
    }

    this.nodes.set(
      node.id,
      new NNTreeNode(node.id, nextNodes, {
        type: "subflow",
        name: node.data.name,
        stereotype: node.data.stereotype,
        pythonClassName: this.getPythonClassName(diagram, node),
        params: node.data.params,
        entryNode: graph.entryNode,
        nodes: graph.nodes,
      } as SubflowData),
    );
    this.runtimeProducerByVisualId.set(node.id, node.id);
    return node.id;
  }

  private createSequential(node: Node, diagram: DiagramCore, visited: Set<string>, childs: Node[]): string {
    let seq = [];
    const sequenceVisualIds = [node.id];
    seq.push(this.nodeToModule(node, diagram))
    do {
      let child = childs[0];
      let parents = diagram.getParents(child.id);
      if (parents.length > 1) {
        break;
      }
      if (this.isSubflowNode(child)) {
        break;
      }
      if (child.data.stereotype === "Fork") {
        break;
      }
      visited.add(child.id);
      childs = diagram.getChilds(child.id);
      if (childs.length === 0) {
        this.lossNode = {
          type: "module",
          moduleId: child.id,
          name: child.data.name,
          stereotype: child.data.stereotype,
          pythonClassName: this.getPythonClassName(diagram, child),
          taskType: this.getTaskType(diagram, child),
          params: child.data.params
        } as ModuleData;
        break
      }
      seq.push(this.nodeToModule(child, diagram))
      sequenceVisualIds.push(child.id);

    } while (childs.length === 1);

    let next_tree_nodes: string[] = [];
    for (const child of childs) {
      let nn_node = this.processNode(child, diagram, visited);
      if (nn_node !== undefined)
        next_tree_nodes.push(nn_node);
    }
    this.nodes.set(node.id, new NNTreeNode(node.id, next_tree_nodes, {
      type: "sequential",
      layers: seq,
    }));
    for (const visualId of sequenceVisualIds) {
      this.runtimeProducerByVisualId.set(visualId, node.id);
    }
    return node.id;

  }

  private handleJoin(node: Node, diagram: DiagramCore, visited: Set<string>): string {
    let childs = diagram.getChilds(node.id);
    let next_tree_nodes: string[] = [];
    for (const child of childs) {
      let nn_node = this.processNode(child, diagram, visited);
      if (nn_node !== undefined)
        next_tree_nodes.push(nn_node);
    }
    this.nodes.set(node.id, new NNTreeNode(node.id, next_tree_nodes, {
      type: "join",
      name: node.data.name,
      stereotype: node.data.stereotype,
      pythonClassName: this.getPythonClassName(diagram, node),
      params: node.data.params,
      inputs: orderPredecessors(diagram.edges, node.id),
    } as JoinData));
    this.runtimeProducerByVisualId.set(node.id, node.id);
    return node.id;

  }

  private processNode(node: Node, diagram: DiagramCore, visited: Set<string>): string | undefined {
    if (visited.has(node.id)) {
      // The node was already emitted into the tree. This is a legitimate DAG
      // cross-edge — e.g. two branches reconverging on the same join — not a
      // cycle: the constructor rejected any directed cycle before traversal,
      // so a re-visit can only be a completed node reached again.
      return node.id;
    }
    visited.add(node.id);

    if (this.isSubflowNode(node)) {
      return this.processSubflow(node, diagram, visited);
    }

    let parents = diagram.getParents(node.id);
    if (parents.length > 1) {
      return this.handleJoin(node, diagram, visited);
    }

    let childs = diagram.getChilds(node.id);
    if (childs.length === 1) {
      return this.createSequential(node, diagram, visited, childs);
    } else if (childs.length > 1) {
      let next_tree_nodes: string[] = [];
      for (const child of childs) {
        let nn_node = this.processNode(child, diagram, visited);
        if (nn_node !== undefined)
          next_tree_nodes.push(nn_node);
      }
      this.nodes.set(node.id, new NNTreeNode(node.id, next_tree_nodes, this.nodeToModule(node, diagram)));
      this.runtimeProducerByVisualId.set(node.id, node.id);
      return node.id;
    } else {
      this.lossNode = {
        type: "module",
        name: node.data.name,
        stereotype: node.data.stereotype,
        pythonClassName: this.getPythonClassName(diagram, node),
        taskType: this.getTaskType(diagram, node),
        params: node.data.params,
      } as ModuleData;
      return;
    }
  }

  public toJson(): string {
    const serializableObject = {
      root: this.root,
      lossNode: this.lossNode,
      nodes: Object.fromEntries(this.nodes)
    };

    return JSON.stringify(serializableObject, null, 2);
  }
}

export class NNTreeNode {
  public id: string;
  public children: string[] = [];
  public data: SequentialData | ModuleData | JoinData | SubflowData;

  constructor(id: string, children: string[], data: SequentialData | ModuleData | JoinData | SubflowData) {
    this.id = id;
    this.children = children;
    this.data = data;
  }


  addChild(child: string): void {
    this.children.push(child);
  }

  removeChild(childId: string): boolean {
    const index = this.children.findIndex((c) => c === childId);
    if (index !== -1) {
      this.children.splice(index, 1);
      return true;
    }
    return false;
  }

  isSequential(): boolean {
    return (this.data as SequentialData).type === "sequential";
  }

  isJoin(): boolean {
    return (this.data as JoinData).type === "join";
  }

  isModule(): boolean {
    return (this.data as ModuleData).type === "module";
  }

  isSubflow(): boolean {
    return (this.data as SubflowData).type === "subflow";
  }

}

export interface SequentialData {
  type: "sequential";
  layers: ModuleData[];
}

export interface JoinData {
  type: "join";
  name: string;
  stereotype: string;
  pythonClassName?: string;
  params: any;
  inputs: string[];
}

export interface ModuleData {
  type: "module";
  name: string;
  stereotype: string;
  pythonClassName?: string;
  taskType?: string;
  params: any;
}

export interface SubflowData {
  type: "subflow";
  name: string;
  stereotype: string;
  pythonClassName?: string;
  params: any;
  entryNode: string;
  nodes: Record<string, InternalNodeData>;
}

export interface SubflowGraph {
  entryNode: string;
  nodes: Record<string, InternalNodeData>;
}

export interface InternalNodeData {
  type: "module" | "join" | "subflow";
  name: string;
  stereotype: string;
  pythonClassName?: string;
  taskType?: string;
  params: any;
  children: string[];
  inputs?: string[];
  entryNode?: string;
  nodes?: Record<string, InternalNodeData>;
}

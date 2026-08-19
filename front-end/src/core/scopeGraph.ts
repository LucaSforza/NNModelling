import type { Edge, Node } from "@xyflow/svelte";

export interface ScopeGraph<N extends { readonly id: string } = Node> {
  readonly nodes: readonly N[];
  readonly edges: readonly Edge[];
  readonly topologicalOrder: readonly string[];
  readonly entryId: string;
  readonly exitId: string;
  readonly predecessors: ReadonlyMap<string, readonly string[]>;
  readonly successors: ReadonlyMap<string, readonly string[]>;
}

export interface ScopeGraphOptions<N extends { readonly id: string }> {
  /** A declared boundary entry must agree with the sole topology source. */
  readonly isEntry?: (node: N) => boolean;
}

/**
 * Describe one self-contained DAG. The descriptor deliberately knows no
 * stereotype names: callers decide which nodes declare a boundary entry.
 */
export function describeScopeGraph<N extends { readonly id: string }>(
  nodes: readonly N[],
  edges: readonly Edge[],
  options: ScopeGraphOptions<N> = {},
): ScopeGraph<N> {
  if (nodes.length === 0) throw new Error("Scope has no internal nodes");
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const internalEdges = edges.filter((edge) => byId.has(edge.source) && byId.has(edge.target));
  const predecessors = new Map(nodes.map((node) => [node.id, [] as string[]]));
  const successors = new Map(nodes.map((node) => [node.id, [] as string[]]));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));

  for (const edge of internalEdges) {
    predecessors.get(edge.target)!.push(edge.source);
    successors.get(edge.source)!.push(edge.target);
    indegree.set(edge.target, indegree.get(edge.target)! + 1);
  }
  for (const node of nodes) predecessors.set(node.id, orderPredecessors(internalEdges, node.id));

  const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  const topologicalOrder: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    topologicalOrder.push(id);
    for (const target of successors.get(id)!) {
      const next = indegree.get(target)! - 1;
      indegree.set(target, next);
      if (next === 0) queue.push(target);
    }
  }
  if (topologicalOrder.length !== nodes.length) {
    const cyclic = nodes.filter((node) => !topologicalOrder.includes(node.id)).map((node) => node.id);
    throw new Error(`Scope contains a cycle: ${cyclic.join(", ")}`);
  }

  const sources = nodes.filter((node) => predecessors.get(node.id)!.length === 0);
  if (sources.length !== 1) throw new Error(`Scope must have exactly one entry, found ${sources.length}`);
  const declared = options.isEntry ? nodes.filter(options.isEntry) : [];
  if (declared.length > 1) throw new Error(`Scope must have at most one declared entry, found ${declared.length}`);
  if (declared.length === 1 && declared[0].id !== sources[0].id) throw new Error("Declared scope entry must be the structural entry");
  const exits = nodes.filter((node) => successors.get(node.id)!.length === 0);
  if (exits.length !== 1) throw new Error(`Scope must have exactly one exit, found ${exits.length}`);

  return { nodes, edges: internalEdges, topologicalOrder, entryId: sources[0].id, exitId: exits[0].id, predecessors, successors };
}

/** Target-handle order is semantic for non-commutative joins. */
export function orderPredecessors(edges: readonly Edge[], targetId: string): string[] {
  const numbered: Array<{ index: number; order: number; source: string }> = [];
  const legacy: Array<{ order: number; source: string }> = [];
  edges.forEach((edge, order) => {
    if (edge.target !== targetId) return;
    const match = edge.targetHandle?.match(/^in-(\d+)$/);
    if (match) numbered.push({ index: Number(match[1]), order, source: edge.source });
    else legacy.push({ order, source: edge.source });
  });
  numbered.sort((left, right) => left.index - right.index || left.order - right.order);
  legacy.sort((left, right) => left.order - right.order);
  return [...numbered.map((entry) => entry.source), ...legacy.map((entry) => entry.source)];
}

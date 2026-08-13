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

/** A normalized containment scope is either the direct parent ID or top-level. */
export type ContainmentScope = string | null;

export interface ContainmentValidation {
  valid: boolean;
  reason?: string;
}

interface ContainmentNode {
  id: string;
  type?: string;
  parentId?: string | null;
}

interface ContainmentEdge {
  source: string;
  target: string;
}

interface NodeMapResult {
  valid: boolean;
  reason?: string;
  nodes?: Map<string, ContainmentNode>;
}

function valid(): ContainmentValidation {
  return { valid: true };
}

function invalid(reason: string): ContainmentValidation {
  return { valid: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Normalizes the only scope relation relevant to edges: an edge belongs to
 * the scope represented by each endpoint's immediate parent, or top-level.
 * Ancestors do not participate in this comparison.
 */
export function normalizedScope(
  node: { parentId?: string | null } | null | undefined,
): ContainmentScope {
  return node?.parentId ?? null;
}

function buildNodeMap(nodes: readonly unknown[]): NodeMapResult {
  const byId = new Map<string, ContainmentNode>();

  for (const candidate of nodes) {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || candidate.id.length === 0) {
      return { valid: false, reason: "Every imported node must have a non-empty string id" };
    }
    if (
      candidate.parentId !== undefined &&
      candidate.parentId !== null &&
      typeof candidate.parentId !== "string"
    ) {
      return { valid: false, reason: `Node '${candidate.id}' has an invalid parentId` };
    }
    if (byId.has(candidate.id)) {
      return { valid: false, reason: `Duplicate node id '${candidate.id}'` };
    }

    byId.set(candidate.id, candidate as unknown as ContainmentNode);
  }

  return { valid: true, nodes: byId };
}

function readEdge(candidate: unknown): ContainmentEdge | ContainmentValidation {
  if (
    !isRecord(candidate) ||
    typeof candidate.source !== "string" ||
    candidate.source.length === 0 ||
    typeof candidate.target !== "string" ||
    candidate.target.length === 0
  ) {
    return invalid("Every edge must have non-empty string source and target IDs");
  }
  return candidate as unknown as ContainmentEdge;
}

function isValidation(value: ContainmentEdge | ContainmentValidation): value is ContainmentValidation {
  return "valid" in value;
}

function validateParentChain(
  nodeId: string,
  nodes: Map<string, ContainmentNode>,
): ContainmentValidation {
  const node = nodes.get(nodeId);
  if (!node) {
    return invalid(`Unknown node '${nodeId}'`);
  }

  const visited = new Set<string>([node.id]);
  let current = node;
  while (current.parentId !== undefined && current.parentId !== null) {
    const parent = nodes.get(current.parentId);
    if (!parent) {
      return invalid(`Node '${current.id}' references missing parent '${current.parentId}'`);
    }
    if (parent.type !== "subflow") {
      return invalid(`Node '${current.id}' parent '${parent.id}' must be a subflow`);
    }
    if (visited.has(parent.id)) {
      return invalid(`Containment parent cycle includes '${parent.id}'`);
    }
    visited.add(parent.id);
    current = parent;
  }

  return valid();
}

/**
 * Validates every parent reference, parent type and parent chain in a graph.
 * It is deliberately state-free so imports and drag reparenting share the
 * exact same containment rules.
 */
export function validateParentChains(nodes: readonly unknown[]): ContainmentValidation {
  const mapResult = buildNodeMap(nodes);
  if (!mapResult.valid) return invalid(mapResult.reason!);

  for (const nodeId of mapResult.nodes!.keys()) {
    const result = validateParentChain(nodeId, mapResult.nodes!);
    if (!result.valid) return result;
  }
  return valid();
}

/**
 * Validates that an edge has existing endpoints in the same immediate scope.
 * Both endpoint parent chains are checked as well, so an unresolved or invalid
 * parent cannot be used to evade the scope boundary.
 */
export function validateSameScopeEdge(
  nodes: readonly unknown[],
  edge: unknown,
): ContainmentValidation {
  const mapResult = buildNodeMap(nodes);
  if (!mapResult.valid) return invalid(mapResult.reason!);
  const parsedEdge = readEdge(edge);
  if (isValidation(parsedEdge)) return parsedEdge;

  const source = mapResult.nodes!.get(parsedEdge.source);
  const target = mapResult.nodes!.get(parsedEdge.target);
  if (!source || !target) {
    const missingId = !source ? parsedEdge.source : parsedEdge.target;
    return invalid(`Edge references unknown node '${missingId}'`);
  }

  const sourceChain = validateParentChain(source.id, mapResult.nodes!);
  if (!sourceChain.valid) return sourceChain;
  const targetChain = validateParentChain(target.id, mapResult.nodes!);
  if (!targetChain.valid) return targetChain;

  const sourceScope = normalizedScope(source);
  const targetScope = normalizedScope(target);
  if (sourceScope !== targetScope) {
    return invalid(
      `Edge '${parsedEdge.source}' -> '${parsedEdge.target}' crosses containment scopes`,
    );
  }
  return valid();
}

/** Validate all edge scopes after parent-chain validation has succeeded. */
export function validateEdgeScopes(
  nodes: readonly unknown[],
  edges: readonly unknown[],
): ContainmentValidation {
  const parentValidation = validateParentChains(nodes);
  if (!parentValidation.valid) return parentValidation;

  for (const edge of edges) {
    const edgeValidation = validateSameScopeEdge(nodes, edge);
    if (!edgeValidation.valid) return edgeValidation;
  }
  return valid();
}

/** Validate the complete containment portion of an imported graph. */
export function validateContainmentGraph(
  nodes: readonly unknown[],
  edges: readonly unknown[],
): ContainmentValidation {
  return validateEdgeScopes(nodes, edges);
}

function wouldCreateParentCycleInMap(
  nodes: Map<string, ContainmentNode>,
  nodeId: string,
  newParentId: string,
): boolean {
  const visited = new Set<string>();
  let current = nodes.get(newParentId);
  while (current) {
    if (current.id === nodeId || visited.has(current.id)) return true;
    visited.add(current.id);
    if (current.parentId === undefined || current.parentId === null) return false;
    current = nodes.get(current.parentId);
  }
  return false;
}

/**
 * Returns whether assigning `newParentId` would place a node in its own
 * ancestry. Invalid parent references are reported by validateReparenting.
 */
export function wouldCreateParentCycle(
  nodes: readonly unknown[],
  nodeId: string,
  newParentId: string | null | undefined,
): boolean {
  if (newParentId === undefined || newParentId === null) return false;
  const mapResult = buildNodeMap(nodes);
  if (!mapResult.valid || !mapResult.nodes?.has(nodeId) || !mapResult.nodes.has(newParentId)) {
    return false;
  }
  return wouldCreateParentCycleInMap(mapResult.nodes, nodeId, newParentId);
}

/**
 * Preflights a reparent operation without changing any node or edge. It keeps
 * existing ancestry protection and rejects a move that would make any
 * incident edge cross a containment boundary.
 */
export function validateReparenting(
  nodes: readonly unknown[],
  edges: readonly unknown[],
  nodeId: string,
  newParentId: string | null | undefined,
): ContainmentValidation {
  const parentValidation = validateParentChains(nodes);
  if (!parentValidation.valid) return parentValidation;

  const mapResult = buildNodeMap(nodes);
  if (!mapResult.valid) return invalid(mapResult.reason!);
  const node = mapResult.nodes!.get(nodeId);
  if (!node) return invalid(`Unknown node '${nodeId}'`);

  const nextScope = newParentId ?? null;
  if (nextScope !== null) {
    const parent = mapResult.nodes!.get(nextScope);
    if (!parent) return invalid(`Node '${nodeId}' references missing parent '${nextScope}'`);
    if (parent.type !== "subflow") {
      return invalid(`Node '${nodeId}' parent '${nextScope}' must be a subflow`);
    }
    if (wouldCreateParentCycleInMap(mapResult.nodes!, node.id, nextScope)) {
      return invalid(`Reparenting '${node.id}' would create a containment parent cycle`);
    }
  }

  for (const candidate of edges) {
    const parsedEdge = readEdge(candidate);
    if (isValidation(parsedEdge)) return parsedEdge;
    if (parsedEdge.source !== nodeId && parsedEdge.target !== nodeId) continue;

    const source = mapResult.nodes!.get(parsedEdge.source);
    const target = mapResult.nodes!.get(parsedEdge.target);
    if (!source || !target) {
      const missingId = !source ? parsedEdge.source : parsedEdge.target;
      return invalid(`Edge references unknown node '${missingId}'`);
    }
    const sourceScope = source.id === nodeId ? nextScope : normalizedScope(source);
    const targetScope = target.id === nodeId ? nextScope : normalizedScope(target);
    if (sourceScope !== targetScope) {
      return invalid(
        `Reparenting '${node.id}' would make edge '${parsedEdge.source}' -> '${parsedEdge.target}' cross containment scopes`,
      );
    }
  }

  return valid();
}

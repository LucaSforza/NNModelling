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

import {
  Graph,
  layout,
  type GraphLabel,
  type NodeLabel,
} from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/svelte";
import {
  normalizedScope,
  type ContainmentScope,
} from "../core/containment";

export type LayoutDirection = "vertical" | "horizontal";

/** Fixed geometry for the first automatic-layout iteration. */
export const AUTO_LAYOUT_GEOMETRY = {
  rankSeparation: 96,
  nodeSeparation: 64,
  edgeSeparation: 24,
  subflowSidePadding: 32,
  subflowHeaderHeight: 36,
  subflowContentTopPadding: 16,
  subflowContentBottomPadding: 24,
  subflowParameterRowHeight: 22,
  minimumExpandedSubflowWidth: 200,
  minimumExpandedSubflowHeight: 50,
  collapsedSubflowWidth: 250,
  collapsedSubflowHeight: 50,
  defaultNodeWidth: 140,
  defaultNodeHeight: 80,
  inputNodeWidth: 30,
  inputNodeHeight: 30,
  joinCrossSize: 46,
  defaultExpandedSubflowWidth: 400,
  defaultExpandedSubflowHeight: 300,
} as const;

interface NodeSize {
  width: number;
  height: number;
}

interface SubflowInsets {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface PositionedNode {
  id: string;
  width: number;
  height: number;
  x: number;
  y: number;
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function fallbackNodeSize(node: Node, direction: LayoutDirection): NodeSize {
  if (node.type === "subflow") {
    return {
      width: AUTO_LAYOUT_GEOMETRY.defaultExpandedSubflowWidth,
      height: AUTO_LAYOUT_GEOMETRY.defaultExpandedSubflowHeight,
    };
  }

  if (node.type === "join") {
    const rawInputsCount = finitePositive(node.data?.inputsCount);
    const inputsCount = Math.max(2, Math.floor(rawInputsCount ?? 2));
    const inputSpan = Math.max(164, 104 + inputsCount * 30);
    return direction === "horizontal"
      ? { width: AUTO_LAYOUT_GEOMETRY.joinCrossSize, height: inputSpan }
      : { width: inputSpan, height: AUTO_LAYOUT_GEOMETRY.joinCrossSize };
  }

  if (node.data?.isInput === true) {
    return {
      width: AUTO_LAYOUT_GEOMETRY.inputNodeWidth,
      height: AUTO_LAYOUT_GEOMETRY.inputNodeHeight,
    };
  }

  return {
    width: AUTO_LAYOUT_GEOMETRY.defaultNodeWidth,
    height: AUTO_LAYOUT_GEOMETRY.defaultNodeHeight,
  };
}

function resolveNodeSize(
  node: Node,
  calculatedSubflows: ReadonlySet<string>,
  direction: LayoutDirection,
): NodeSize {
  const fallback = fallbackNodeSize(node, direction);
  // Join dimensions are directional and depend on the live input count. A
  // measurement from the previous orientation is necessarily stale.
  if (node.type === "join") return fallback;
  const explicitFirst = node.type === "subflow" && (
    calculatedSubflows.has(node.id) || node.data?.isCollapsed === true
  );

  const firstWidth = explicitFirst ? node.width : node.measured?.width;
  const secondWidth = explicitFirst ? node.measured?.width : node.width;
  const firstHeight = explicitFirst ? node.height : node.measured?.height;
  const secondHeight = explicitFirst ? node.measured?.height : node.height;

  return {
    width: finitePositive(firstWidth) ?? finitePositive(secondWidth) ?? fallback.width,
    height: finitePositive(firstHeight) ?? finitePositive(secondHeight) ?? fallback.height,
  };
}

function countPositionedParameters(node: Node): { top: number; bottom: number } {
  if (!node.data?.stereotype) return { top: 0, bottom: 0 };
  const params = node.data.params;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return { top: 0, bottom: 0 };
  }

  let top = 0;
  let bottom = 0;
  for (const value of Object.values(params)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const position = (value as Record<string, unknown>).position;
    if (position === "top") top += 1;
    if (position === "bottom") bottom += 1;
  }
  return { top, bottom };
}

function subflowInsets(node: Node): SubflowInsets {
  const parameters = countPositionedParameters(node);
  return {
    left: AUTO_LAYOUT_GEOMETRY.subflowSidePadding,
    right: AUTO_LAYOUT_GEOMETRY.subflowSidePadding,
    top:
      AUTO_LAYOUT_GEOMETRY.subflowHeaderHeight +
      parameters.top * AUTO_LAYOUT_GEOMETRY.subflowParameterRowHeight +
      AUTO_LAYOUT_GEOMETRY.subflowContentTopPadding,
    bottom:
      parameters.bottom * AUTO_LAYOUT_GEOMETRY.subflowParameterRowHeight +
      AUTO_LAYOUT_GEOMETRY.subflowContentBottomPadding,
  };
}

function roundCoordinate(value: number): number {
  const rounded = Math.round(value);
  return Object.is(rounded, -0) ? 0 : rounded;
}

function edgeOrderKey(edge: Edge): string {
  return [
    edge.target,
    edge.targetHandle ?? "",
    edge.source,
    edge.sourceHandle ?? "",
    edge.id,
  ].join("\u0000");
}

function parentFirstOrder(nodes: readonly Node[], workingById: ReadonlyMap<string, Node>): Node[] {
  const ordered: Node[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const addNode = (nodeId: string): void => {
    if (visited.has(nodeId)) return;
    if (visiting.has(nodeId)) {
      throw new Error(`Containment cycle encountered while ordering node '${nodeId}'`);
    }

    const node = workingById.get(nodeId);
    if (!node) throw new Error(`Unknown layout node '${nodeId}'`);

    visiting.add(nodeId);
    if (node.parentId != null) {
      if (!workingById.has(node.parentId)) {
        throw new Error(`Node '${node.id}' references missing parent '${node.parentId}'`);
      }
      addNode(node.parentId);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    ordered.push(node);
  };

  for (const node of nodes) addNode(node.id);
  return ordered;
}

/**
 * Compute complete compound-graph geometry without mutating diagram state.
 * The caller owns containment validation and applies the returned node array.
 */
export function computeAutoLayout(
  nodes: readonly Node[],
  edges: readonly Edge[],
  direction: LayoutDirection,
): Node[] {
  if (direction !== "vertical" && direction !== "horizontal") {
    throw new Error(`Unsupported layout direction '${String(direction)}'`);
  }

  const workingById = new Map<string, Node>();
  const childrenByScope = new Map<ContainmentScope, string[]>();
  const edgesByScope = new Map<ContainmentScope, Edge[]>();

  for (const sourceNode of nodes) {
    if (workingById.has(sourceNode.id)) {
      throw new Error(`Duplicate layout node id '${sourceNode.id}'`);
    }
    const node = {
      ...sourceNode,
      position: { ...sourceNode.position },
    } as Node;
    workingById.set(node.id, node);
    const scope = normalizedScope(node);
    const children = childrenByScope.get(scope) ?? [];
    children.push(node.id);
    childrenByScope.set(scope, children);
  }

  for (const edge of edges) {
    const source = workingById.get(edge.source);
    const target = workingById.get(edge.target);
    if (!source || !target) {
      const missingId = !source ? edge.source : edge.target;
      throw new Error(`Layout edge '${edge.id}' references missing node '${missingId}'`);
    }
    const sourceScope = normalizedScope(source);
    const targetScope = normalizedScope(target);
    if (sourceScope !== targetScope) {
      throw new Error(`Layout edge '${edge.id}' crosses containment scopes`);
    }
    const scopeEdges = edgesByScope.get(sourceScope) ?? [];
    scopeEdges.push(edge);
    edgesByScope.set(sourceScope, scopeEdges);
  }

  const calculatedSubflows = new Set<string>();
  const laidOutScopes = new Set<ContainmentScope>();
  const activeScopes = new Set<ContainmentScope>();

  const layoutScope = (scope: ContainmentScope): void => {
    if (laidOutScopes.has(scope)) return;
    if (activeScopes.has(scope)) {
      throw new Error(`Containment cycle encountered while laying out scope '${String(scope)}'`);
    }
    activeScopes.add(scope);

    const childIds = childrenByScope.get(scope) ?? [];
    for (const childId of childIds) {
      const child = workingById.get(childId)!;
      if (child.type === "subflow") layoutScope(child.id);
    }

    let positioned: PositionedNode[] = [];
    if (childIds.length > 0) {
      const graph = new Graph<GraphLabel, NodeLabel, Record<string, never>>({
        directed: true,
        multigraph: false,
        compound: false,
      });
      graph.setGraph({
        rankdir: direction === "vertical" ? "TB" : "LR",
        ranksep: AUTO_LAYOUT_GEOMETRY.rankSeparation,
        nodesep: AUTO_LAYOUT_GEOMETRY.nodeSeparation,
        edgesep: AUTO_LAYOUT_GEOMETRY.edgeSeparation,
        marginx: 0,
        marginy: 0,
        ranker: "network-simplex",
      });
      graph.setDefaultEdgeLabel(() => ({}));

      const sizes = new Map<string, NodeSize>();
      for (const childId of [...childIds].sort()) {
        const child = workingById.get(childId)!;
        const size = resolveNodeSize(child, calculatedSubflows, direction);
        sizes.set(childId, size);
        graph.setNode(childId, { width: size.width, height: size.height });
      }

      const insertedEdges = new Set<string>();
      const scopeEdges = [...(edgesByScope.get(scope) ?? [])]
        .sort((a, b) => edgeOrderKey(a).localeCompare(edgeOrderKey(b)));
      for (const edge of scopeEdges) {
        const endpointKey = `${edge.source}\u0000${edge.target}`;
        if (insertedEdges.has(endpointKey)) continue;
        insertedEdges.add(endpointKey);
        graph.setEdge(edge.source, edge.target, {});
      }

      layout(graph);

      positioned = childIds.map((childId) => {
        const label = graph.node(childId);
        const size = sizes.get(childId)!;
        if (!label || !Number.isFinite(label.x) || !Number.isFinite(label.y)) {
          throw new Error(`Dagre did not position node '${childId}'`);
        }
        return {
          id: childId,
          width: size.width,
          height: size.height,
          x: label.x! - size.width / 2,
          y: label.y! - size.height / 2,
        };
      });

      const minimumX = Math.min(...positioned.map((node) => node.x));
      const minimumY = Math.min(...positioned.map((node) => node.y));
      const parent = scope === null ? undefined : workingById.get(scope);
      if (scope !== null && (!parent || parent.type !== "subflow")) {
        throw new Error(`Layout scope '${scope}' is not a subflow`);
      }
      const insets = parent
        ? subflowInsets(parent)
        : { left: 0, top: 0, right: 0, bottom: 0 };

      positioned = positioned.map((node) => ({
        ...node,
        x: roundCoordinate(node.x - minimumX + insets.left),
        y: roundCoordinate(node.y - minimumY + insets.top),
      }));

      for (const placement of positioned) {
        const child = workingById.get(placement.id)!;
        workingById.set(placement.id, {
          ...child,
          position: { x: placement.x, y: placement.y },
          ...(child.type === "join" && {
            width: placement.width,
            height: placement.height,
          }),
        } as Node);
      }
    }

    if (scope !== null) {
      const subflow = workingById.get(scope);
      if (!subflow || subflow.type !== "subflow") {
        throw new Error(`Layout scope '${scope}' is not a subflow`);
      }
      const insets = subflowInsets(subflow);
      const contentWidth = positioned.length === 0
        ? 0
        : Math.max(...positioned.map((node) => node.x - insets.left + node.width));
      const contentHeight = positioned.length === 0
        ? 0
        : Math.max(...positioned.map((node) => node.y - insets.top + node.height));
      const expandedWidth = Math.ceil(Math.max(
        AUTO_LAYOUT_GEOMETRY.minimumExpandedSubflowWidth,
        insets.left + contentWidth + insets.right,
      ));
      const expandedHeight = Math.ceil(Math.max(
        AUTO_LAYOUT_GEOMETRY.minimumExpandedSubflowHeight,
        insets.top + contentHeight + insets.bottom,
      ));
      const collapsed = subflow.data?.isCollapsed === true;

      workingById.set(scope, {
        ...subflow,
        width: collapsed
          ? AUTO_LAYOUT_GEOMETRY.collapsedSubflowWidth
          : expandedWidth,
        height: collapsed
          ? AUTO_LAYOUT_GEOMETRY.collapsedSubflowHeight
          : expandedHeight,
        data: {
          ...subflow.data,
          oldWidth: expandedWidth,
          oldHeight: expandedHeight,
        },
      } as Node);
      calculatedSubflows.add(scope);
    }

    activeScopes.delete(scope);
    laidOutScopes.add(scope);
  };

  layoutScope(null);
  return parentFirstOrder(nodes, workingById);
}

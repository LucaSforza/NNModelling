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

import { type Node, type Edge } from "@xyflow/svelte";

/** Stub window so Diagram constructor can auto-spawn Input node. */
export function stubWindow() {
  (globalThis as any).window = { innerWidth: 1024 };
}

export function unstubWindow() {
  delete (globalThis as any).window;
}

/** Factory for test Node — 1 line instead of 5. */
export function node(
  id: string,
  stereotype: string,
  name: string,
  params: Record<string, { value: string; position?: string }> = {},
  overrides?: {
    color?: string;
    type?: string;
    isInput?: boolean;
    isLoss?: boolean;
    parentId?: string;
    hidden?: boolean;
  },
): Node {
  return {
    id,
    type: overrides?.type ?? "custom",
    position: { x: 0, y: 0 },
    parentId: overrides?.parentId,
    hidden: overrides?.hidden,
    data: {
      stereotype,
      name,
      color: overrides?.color ?? "#ccc",
      params: structuredClone(params),
      isInput: overrides?.isInput ?? false,
      isLoss: overrides?.isLoss ?? false,
    },
  } as Node;
}

/** Factory for test Edge. */
export function edge(
  id: string,
  source: string,
  target: string,
  handles?: { sourceHandle?: string; targetHandle?: string },
): Edge {
  return { id, source, target, ...handles } as Edge;
}

// ─────────────────────────────────────────────────────────────────────────────
// Type engine test helpers
// ─────────────────────────────────────────────────────────────────────────────


/**
 * Assert that a node in the TypeResult has the expected output shape.
 * Shape is specified as an array of descriptive strings:
 *   "784" → const dim with value 784
 *   "$B"  → symbolic dim with name "B"
 *   "*"   → wildcard (not checked strictly)
 */
export function expectOutputShape(
  result: TypeResult,
  nodeId: string,
  expected: string[],
): void {
  const ann = result.annotations.get(nodeId);
  if (!ann) throw new Error(`No annotation found for node ${nodeId}`);
  const shape = ann.outputType.shape;
  if (shape.length !== expected.length) {
    throw new Error(
      `Shape length mismatch for ${nodeId}: expected ${expected.length} dims, got ${shape.length}`,
    );
  }
  for (let i = 0; i < expected.length; i++) {
    const exp = expected[i];
    const dim = shape[i];
    if (exp.startsWith('$')) {
      // Symbolic dim
      if (dim.kind !== 'symbolic') {
        throw new Error(`Expected symbolic dim at position ${i}, got ${dim.kind}`);
      }
      if (dim.name !== exp.slice(1) && dim.name !== exp) {
        throw new Error(
          `Symbolic name mismatch at ${i}: expected ${exp.slice(1)}, got ${dim.name}`,
        );
      }
    } else if (exp === '*') {
      // Wildcard — skip strict check
      continue;
    } else {
      // Const dim
      const val = parseInt(exp, 10);
      if (isNaN(val)) throw new Error(`Invalid expected shape value: ${exp}`);
      if (dim.kind !== 'const') {
        throw new Error(`Expected const dim at position ${i}, got ${dim.kind}`);
      }
      if (dim.value !== val) {
        throw new Error(`Const value mismatch at ${i}: expected ${val}, got ${dim.value}`);
      }
    }
  }
}

/**
 * Assert that a TypeResult contains a specific error for a node.
 */
export function expectTypeError(
  result: TypeResult,
  nodeId: string,
  messageContains?: string,
): void {
  const matching = result.errors.filter(e => e.nodeId === nodeId);
  if (matching.length === 0) {
    throw new Error(
      `No errors found for node ${nodeId}. Errors: ${result.errors.map(e => `${e.nodeId}: ${e.message}`).join('; ')}`,
    );
  }
  if (messageContains) {
    const hasMessage = matching.some(e => e.message.includes(messageContains));
    if (!hasMessage) {
      throw new Error(
        `No error for ${nodeId} contains "${messageContains}". Errors: ${matching.map(e => e.message).join('; ')}`,
      );
    }
  }
}

/*
 * NNModelling — DSL for designing neural networks via visual node editor
 * Copyright (C) 2026  Luca Sforza
 *
 * Licensed under the GNU General Public License v3 or later.
 */

export const PNG_EXPORT_PADDING = 24;

const excludedPngClasses = new Set([
  "svelte-flow__panel",
  "svelte-flow__controls",
  "svelte-flow__attribution",
  // The transparent pointer-capture path and selected-edge controls are UI
  // affordances, not part of the persisted route rendered in an export.
  "svelte-flow__edge-interaction",
  "editable-edge-hit-target",
]);

export type PngExportBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PngExportLayout = {
  width: number;
  height: number;
  viewport: {
    x: number;
    y: number;
    zoom: number;
  };
};

export type PngEdgeStyle = {
  stroke: string;
  strokeWidth: string;
  fill: string;
};

export function shouldIncludePngElement(
  element: {
    classList?: Pick<DOMTokenList, "contains">;
    getAttribute?: (qualifiedName: string) => string | null;
  },
): boolean {
  if (element.getAttribute?.("data-png-exclude") === "true") return false;
  return !Array.from(excludedPngClasses).some((className) =>
    element.classList?.contains(className),
  );
}

export function getPngEdgeStyle(style: PngEdgeStyle): PngEdgeStyle {
  return {
    stroke: style.stroke,
    strokeWidth: style.strokeWidth,
    fill: style.fill,
  };
}

export function getPngExportLayout(
  bounds: PngExportBounds,
  padding = PNG_EXPORT_PADDING,
): PngExportLayout {
  return {
    width: Math.max(1, Math.ceil(bounds.width + padding * 2)),
    height: Math.max(1, Math.ceil(bounds.height + padding * 2)),
    viewport: {
      x: padding - bounds.x,
      y: padding - bounds.y,
      zoom: 1,
    },
  };
}

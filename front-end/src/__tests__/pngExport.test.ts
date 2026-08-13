/*
 * NNModelling — DSL for designing neural networks via visual node editor
 * Copyright (C) 2026  Luca Sforza
 *
 * Licensed under the GNU General Public License v3 or later.
 */

import { describe, expect, it } from "vitest";
import {
  PNG_EXPORT_PADDING,
  getPngExportLayout,
  getPngEdgeStyle,
  shouldIncludePngElement,
} from "../pngExport";

function elementWithClasses(...classes: string[]) {
  return {
    classList: {
      contains: (className: string) => classes.includes(className),
    },
  };
}

describe("PNG export", () => {
  it.each([
    "svelte-flow__panel",
    "svelte-flow__controls",
    "svelte-flow__attribution",
  ])("excludes the %s UI element", (className) => {
    expect(shouldIncludePngElement(elementWithClasses(className))).toBe(false);
  });

  it("keeps diagram content in the export", () => {
    expect(shouldIncludePngElement(elementWithClasses("svelte-flow__node"))).toBe(true);
  });

  it("keeps nodes without a class list in the export", () => {
    expect(shouldIncludePngElement({})).toBe(true);
  });

  it("converts the CSS edge stroke into inline SVG styles", () => {
    expect(
      getPngEdgeStyle({
        stroke: "rgb(177, 177, 183)",
        strokeWidth: "1px",
        fill: "none",
      }),
    ).toEqual({
      stroke: "rgb(177, 177, 183)",
      strokeWidth: "1px",
      fill: "none",
    });
  });

  it("fits the export canvas around the model bounds", () => {
    const layout = getPngExportLayout(
      { x: -120, y: 48, width: 640, height: 320 },
      PNG_EXPORT_PADDING,
    );

    expect(layout).toEqual({
      width: 640 + PNG_EXPORT_PADDING * 2,
      height: 320 + PNG_EXPORT_PADDING * 2,
      viewport: {
        x: 120 + PNG_EXPORT_PADDING,
        y: PNG_EXPORT_PADDING - 48,
        zoom: 1,
      },
    });
  });
});

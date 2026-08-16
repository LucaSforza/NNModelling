import { describe, expect, it } from "vitest";
import { getOrthogonalRoutePath } from "../edges/routePath";

describe("getOrthogonalRoutePath", () => {
  const endpoints = {
    source: { x: 0, y: 0 },
    target: { x: 100, y: 50 },
    sourcePosition: "right" as const,
    targetPosition: "left" as const,
  };

  it("draws a deterministic automatic orthogonal route", () => {
    expect(getOrthogonalRoutePath(endpoints)).toBe("M 0 0 L 50 0 L 50 50 L 100 50");
  });

  it("treats absent, empty, malformed, and legacy routes as automatic", () => {
    const automatic = getOrthogonalRoutePath(endpoints);
    expect(getOrthogonalRoutePath({ ...endpoints, points: [] })).toBe(automatic);
    expect(getOrthogonalRoutePath({ ...endpoints, points: [{ x: Number.NaN, y: 1 }] })).toBe(automatic);
    expect(getOrthogonalRoutePath({ ...endpoints, points: { x: 1, y: 2 } })).toBe(automatic);
  });

  it("converts one scope-local bend into deterministic orthogonal segments", () => {
    expect(getOrthogonalRoutePath({
      ...endpoints,
      points: [{ x: 20, y: 30 }],
      scopeOrigin: { x: 5, y: 10 },
    })).toBe("M 0 0 L 25 0 L 25 40 L 25 50 L 100 50");
  });

  it("retains multiple manual bends in their scope-local order", () => {
    expect(getOrthogonalRoutePath({
      ...endpoints,
      points: [{ x: 20, y: 30 }, { x: 60, y: 15 }],
    })).toBe("M 0 0 L 20 0 L 20 30 L 20 15 L 60 15 L 60 50 L 100 50");
  });
});

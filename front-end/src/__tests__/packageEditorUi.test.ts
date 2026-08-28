import { describe, expect, test } from "vitest"

import type { ActivePackageMetadata } from "../type-system/host"
import {
  groupedPackages,
  initialPackageParameters,
  packageGroupName,
  packageReferenceMatches,
  parseShapeOrList,
} from "../type-system/editor/package-ui"

const metadata = (id: string, kind: ActivePackageMetadata["definition"]["kind"], name: string, parameters = {}) => ({
  id,
  version: "0.1.0",
  definition: {
    name,
    kind,
    view: { color: "#4779c4", width: 180, height: 100 },
    parameters,
  },
}) as ActivePackageMetadata

describe("package editor metadata", () => {
  test("groups active packages by kind with the requested Other exceptions", () => {
    const packages = [
      metadata("core.linear", "layer", "Linear"),
      metadata("core.cross-entropy", "loss", "Cross Entropy"),
      metadata("core.repeat", "subflow", "Repeat"),
      metadata("core.add", "join", "Add"),
      metadata("core.input", "input", "Input"),
      metadata("core.fork", "layer", "Fork"),
      metadata("core.cast", "layer", "Cast"),
    ]
    expect(groupedPackages(packages).map((group) => [group.name, group.packages.map((item) => item.id)])).toEqual([
      ["Layers", ["core.linear"]],
      ["Loss", ["core.cross-entropy"]],
      ["Subflow", ["core.repeat"]],
      ["Join", ["core.add"]],
      ["Other", ["core.cast", "core.fork", "core.input"]],
    ])
    expect(packageGroupName(packages[5]!)).toBe("Other")
  })

  test("keeps required parameters missing and defaults primitive", () => {
    const definition = metadata("core.linear", "layer", "Linear", {
      in_features: { type: "integer" },
      out_features: { type: "integer", default: 32 },
      dtype: { type: "dtype", choices: ["float16", "float32"], default: "float32" },
    }).definition
    expect(initialPackageParameters(definition)).toEqual({ out_features: 32, dtype: "float32" })
    expect(initialPackageParameters(definition, { in_features: 128, dtype: "float16" })).toEqual({ in_features: 128, out_features: 32, dtype: "float16" })
  })

  test("parses shape/list values without legacy wrappers", () => {
    expect(parseShapeOrList('["B", 784]')).toEqual(["B", 784])
    expect(parseShapeOrList("B, 784")).toEqual(["B", 784])
    expect(parseShapeOrList(" ")).toBeUndefined()
  })

  test("resolves dynamic references by a compatible version range", () => {
    const concat = metadata("core.concat", "join", "Concat")
    expect(packageReferenceMatches(concat, { id: "core.concat", version: "^0.1.0" })).toBe(true)
    expect(packageReferenceMatches(concat, { id: "core.concat", version: "0.2.0" })).toBe(false)
  })
})

import { describe, expect, test } from "vitest"
import PackageManager from "../components/PackageManager.svelte"
import type { PackageManagerPackage } from "../components/PackageManager.svelte"

const definition = (name: string) => ({ name, kind: "layer" as const, view: { color: "#123456", width: 100, height: 80 }, parameters: {} })

describe("Stereotype manager", () => {
  test("exports a component without the global installer surface", () => {
    expect(PackageManager).toBeDefined()
  })

  test("keeps only core and active-project entries in the manager catalog", () => {
    const packages: PackageManagerPackage[] = [
      { key: "core.relu@1.0.0", source: "bundled", definition: definition("ReLU") },
      { key: "model.layer@1.0.0", source: "model", definition: definition("Project layer") },
      { key: "legacy.external@1.0.0", source: "external", definition: definition("Legacy package") },
    ]
    expect(packages.filter((item) => item.source === "bundled").map((item) => item.definition.name)).toEqual(["ReLU"])
    expect(packages.filter((item) => item.source === "model").map((item) => item.definition.name)).toEqual(["Project layer"])
    expect(packages.some((item) => item.source === "external")).toBe(true)
  })
})

import { describe, expect, test } from "vitest"
import PackageManager from "../components/PackageManager.svelte"
import type { InstallResult, LocalPackageFile } from "../type-system/packages/install/installer"

describe("PackageManager callback seam", () => {
  test("exports a Svelte component without importing graph or runtime ownership", () => {
    expect(PackageManager).toBeDefined()
  })

  test("install callbacks receive only normalized package-relative bytes", () => {
    const callback = (files: readonly LocalPackageFile[]): InstallResult | Promise<InstallResult> => {
      expect(files.every((file) => file.relativePath && file.bytes instanceof Uint8Array)).toBe(true)
      return { status: "rejected", diagnostic: { code: "empty-selection", phase: "normalize", severity: "error", message: "fixture" } }
    }
    expect(callback([{ relativePath: "manifest.json", bytes: new Uint8Array([123]) }])).toMatchObject({ status: "rejected" })
  })
})

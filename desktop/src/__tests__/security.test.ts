import { describe, expect, test } from "vitest"
import { isAllowedNavigation, MAIN_WINDOW_WEB_PREFERENCES } from "../security"

describe("desktop renderer boundary", () => {
  test("keeps Node outside the sandboxed, context-isolated renderer", () => {
    expect(MAIN_WINDOW_WEB_PREFERENCES).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    })
  })

  test("allows only application content and the configured development origin", () => {
    expect(isAllowedNavigation("app://nnmodelling/index.html")).toBe(true)
    expect(isAllowedNavigation("https://example.com/")).toBe(false)
    expect(isAllowedNavigation("http://127.0.0.1:5173/editor", "http://127.0.0.1:5173")).toBe(true)
    expect(isAllowedNavigation("http://127.0.0.1:5174/", "http://127.0.0.1:5173")).toBe(false)
  })
})

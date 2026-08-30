import { describe, expect, test } from "vitest"
import { validateProjectPath } from "../src/project-path"

describe("project path boundary", () => {
  test("accepts a canonical model directory under the configured root", () => {
    expect(validateProjectPath("/tmp/projects/demo.model", "/tmp/projects")).toBe("/tmp/projects/demo.model")
  })

  test("rejects relative, traversal, root and invalid model paths", () => {
    expect(() => validateProjectPath("demo", "/tmp/projects")).toThrow("absolute canonical")
    expect(() => validateProjectPath("/tmp/projects/../escape", "/tmp/projects")).toThrow("absolute canonical")
    expect(() => validateProjectPath("/tmp/projects", "/tmp/projects")).toThrow("inside")
    expect(() => validateProjectPath("/tmp/projects/Not Valid", "/tmp/projects")).toThrow("lowercase model ID")
  })

  test("rejects paths outside the configured root and NUL bytes", () => {
    expect(() => validateProjectPath("/tmp/other/demo", "/tmp/projects")).toThrow("inside")
    expect(() => validateProjectPath("/tmp/projects/demo\0file", "/tmp/projects")).toThrow("non-empty")
  })
})

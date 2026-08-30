import path from "node:path"

import { MCPServerError } from "./errors.js"

const PROJECT_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/

/**
 * Validate a user-supplied project path before it crosses the browser bridge.
 * Paths are intentionally lexical here: existing-directory checks belong to
 * the selected filesystem owner, while this function prevents traversal and
 * root replacement in either owner.
 */
export function validateProjectPath(projectPath: string, projectRoot?: string): string {
  if (typeof projectPath !== "string" || projectPath.length === 0 || projectPath.includes("\0")) {
    throw new MCPServerError("INVALID_PROJECT_PATH", "projectPath must be a non-empty path")
  }

  const resolved = path.resolve(projectPath)
  if (resolved !== projectPath || !path.isAbsolute(projectPath)) {
    throw new MCPServerError("INVALID_PROJECT_PATH", "projectPath must be an absolute canonical path")
  }

  if (projectRoot === undefined) {
    throw new MCPServerError("PROJECT_PATH_ROOT_UNCONFIGURED", "explicit project paths require a configured project root")
  }
  const root = path.resolve(projectRoot)
  if (resolved === root || !isWithin(root, resolved)) {
    throw new MCPServerError("PROJECT_PATH_OUTSIDE_ROOT", "projectPath must be inside the configured project root")
  }

  const projectId = path.basename(resolved)
  if (!PROJECT_ID.test(projectId)) {
    throw new MCPServerError("INVALID_PROJECT_PATH", "project directory name must be a lowercase model ID")
  }
  return resolved
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

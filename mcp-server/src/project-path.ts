import path from "node:path"

import { MCPServerError } from "./errors.js"
import fs from "node:fs/promises"

const PROJECT_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

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

export type ProjectPathPayload = {
  readonly projectPath: string
  readonly modelJson: string
  readonly resources: Record<string, { readonly encoding: "utf8" | "base64"; readonly data: string }>
}

export async function createProjectAtPath(
  projectPath: string,
  projectRoot: string | undefined,
  manifest: { id: string; version: string; name: string; description?: string },
): Promise<ProjectPathPayload> {
  const safePath = validateProjectPath(projectPath, projectRoot)
  const id = manifest.id.trim()
  const version = manifest.version.trim()
  const name = manifest.name.trim()
  if (!PROJECT_ID.test(id) || !SEMVER.test(version) || !name) throw new MCPServerError("INVALID_ARGUMENT", "id, version and name must match the project form validation")
  if (path.basename(safePath) !== id) throw new MCPServerError("INVALID_PROJECT_PATH", "projectPath directory must match id")
  const normalizedManifest = { schemaVersion: 1, id, version, name, ...(manifest.description?.trim() ? { description: manifest.description.trim() } : {}), customPackages: [] }
  const modelJson = JSON.stringify({ nodes: [], edges: [], layoutDirection: "vertical", manifest: normalizedManifest }, null, 2)
  try {
    await fs.mkdir(safePath)
    await fs.writeFile(path.join(safePath, "model.json"), modelJson, { encoding: "utf8", flag: "wx" })
  } catch (cause) {
    if ((cause as { code?: string }).code === "EEXIST") throw new MCPServerError("PROJECT_COLLISION", "project directory already exists")
    try { await fs.rm(safePath, { recursive: true, force: true }) } catch { /* preserve original failure */ }
    throw new MCPServerError("PROJECT_CREATE_FAILED", cause instanceof Error ? cause.message : String(cause))
  }
  return { projectPath: safePath, modelJson, resources: { "model.json": { encoding: "utf8", data: modelJson } } }
}

export async function openProjectAtPath(projectPath: string, projectRoot: string | undefined): Promise<ProjectPathPayload> {
  const safePath = validateProjectPath(projectPath, projectRoot)
  const stat = await fs.stat(safePath).catch(() => undefined)
  if (!stat?.isDirectory()) throw new MCPServerError("PROJECT_NOT_FOUND", "project directory does not exist")
  const resources: Record<string, { encoding: "utf8" | "base64"; data: string }> = {}
  await readFiles(safePath, "", resources, { bytes: 0 })
  const model = resources["model.json"]
  if (!model) throw new MCPServerError("MALFORMED_PROJECT", "project directory does not contain model.json")
  try { JSON.parse(model.data) } catch { throw new MCPServerError("MALFORMED_PROJECT", "model.json is not valid JSON") }
  return { projectPath: safePath, modelJson: model.data, resources }
}

export async function saveProjectModel(projectPath: string, projectRoot: string | undefined, modelJson: string): Promise<void> {
  const safePath = validateProjectPath(projectPath, projectRoot)
  try { JSON.parse(modelJson) } catch { throw new MCPServerError("MALFORMED_PROJECT", "model.json is not valid JSON") }
  await fs.writeFile(path.join(safePath, "model.json"), modelJson, { encoding: "utf8" })
}

export async function rollbackCreatedProject(projectPath: string, projectRoot: string | undefined): Promise<void> {
  const safePath = validateProjectPath(projectPath, projectRoot)
  await fs.rm(safePath, { recursive: true, force: false })
}

async function readFiles(
  directory: string,
  prefix: string,
  resources: Record<string, { encoding: "utf8" | "base64"; data: string }>,
  size: { bytes: number },
): Promise<void> {
  if (Object.keys(resources).length >= 512) throw new MCPServerError("PROJECT_TOO_LARGE", "project contains too many files")
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? path.join(prefix, entry.name) : entry.name
    if (entry.isDirectory()) await readFiles(path.join(directory, entry.name), relative, resources, size)
    else if (entry.isFile()) {
      const bytes = await fs.readFile(path.join(directory, entry.name))
      size.bytes += bytes.byteLength
      if (size.bytes > 8 * 1024 * 1024) throw new MCPServerError("PROJECT_TOO_LARGE", "project resources exceed 8 MiB")
      const resourcePath = relative.split(path.sep).join("/")
      resources[resourcePath] = resourcePath === "model.json"
        ? { encoding: "utf8", data: bytes.toString("utf8") }
        : { encoding: "base64", data: bytes.toString("base64") }
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

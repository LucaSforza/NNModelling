import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const repositoryRoot = resolve(import.meta.dirname, "../..")
const frontendRoot = join(repositoryRoot, "front-end")
const forbiddenPaths = [
  join(frontendRoot, "src/conversion/typeEngine.ts"),
  join(frontendRoot, "src/conversion/tensortypes.ts"),
  join(frontendRoot, "src/conversion/typeDiagnostics.ts"),
  join(frontendRoot, "src/core/StereotypeCore.ts"),
  join(repositoryRoot, "Stereotypes"),
]
const failures = []

for (const path of forbiddenPaths) if (existsSync(path)) failures.push(`forbidden legacy path exists: ${path}`)

function walk(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  })
}

for (const path of [...walk(join(frontendRoot, "src")), ...walk(join(repositoryRoot, "mcp-server", "src"))]) {
  const text = readFileSync(path, "utf8")
  for (const token of ["TypeEngine", "StereotypeCore", "Stereotypes/"]) {
    if (text.includes(token)) failures.push(`${path} references forbidden legacy symbol ${token}`)
  }
}

function wrapped(value) {
  if (Array.isArray(value)) return value.some(wrapped)
  if (!value || typeof value !== "object") return false
  const keys = Object.keys(value)
  if (Object.hasOwn(value, "value") && (Object.hasOwn(value, "position") || keys.length <= 2)) return true
  return Object.values(value).some(wrapped)
}

for (const directory of [join(repositoryRoot, "examples/diagrams")]) {
  for (const path of walk(directory).filter(path => path.endsWith(".json"))) {
    let document
    try { document = JSON.parse(readFileSync(path, "utf8")) } catch { failures.push(`${path} is not valid JSON`); continue }
    if (!Array.isArray(document.nodes)) continue
    for (const node of document.nodes) {
      const identity = node?.data?.package
      if (typeof identity?.id !== "string" || typeof identity?.version !== "string" || typeof identity?.name !== "string") {
        failures.push(`${path} node ${String(node?.id)} lacks exact data.package identity`)
      }
      if (wrapped(node?.data?.params)) failures.push(`${path} node ${String(node?.id)} contains wrapped parameter values`)
    }
  }
}

if (failures.length) {
  console.error(failures.join("\n"))
  process.exit(1)
}
console.log("package-only guard: ok")

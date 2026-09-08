import type { GeneratedDatasetResources } from "./dataset-authoring"
import { DatasetContractError, parseDatasetDefinition, parseDatasetSourceManifest, parseModelManifest, type DatasetReference } from "./dataset-contract"
import type { ProjectResourceSet } from "./index"
import type { DatasetInfo } from "../training/api"

export type ProjectDatasetResources = {
  readonly infos: readonly DatasetInfo[]
  readonly resources: ReadonlyMap<string, GeneratedDatasetResources>
}

/** Parse the project manifest and materialize each complete dataset closure. */
export function loadProjectDatasetResources(session: Pick<ProjectResourceSet, "modelJson" | "resources">): ProjectDatasetResources {
  const resources = new Map<string, GeneratedDatasetResources>()
  const infos: DatasetInfo[] = []
  const parsed = JSON.parse(session.modelJson) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("model document must be an object")

  const manifest = parseModelManifest((parsed as { manifest?: unknown }).manifest).manifest
  for (const entry of manifest.customDatasets) {
    if (!entry.path.startsWith("datasets/") || entry.path.split("/").length < 2) {
      throw new DatasetContractError("project dataset path must be under datasets/", "invalid-path", `customDatasets.${entry.id}@${entry.version}.path`)
    }
    const prefix = `${entry.path}/`
    const manifestJson = session.resources[`${prefix}manifest.json`]
    const definitionJson = session.resources[`${prefix}dataset.json`]
    const python = session.resources[`${prefix}dataset.py`]
    const missing = [
      manifestJson === undefined ? "manifest.json" : undefined,
      definitionJson === undefined ? "dataset.json" : undefined,
      python === undefined ? "dataset.py" : undefined,
    ].filter((name): name is string => name !== undefined)
    if (missing.length > 0) throw new Error(`Project dataset '${entry.id}@${entry.version}' is missing ${missing.join(", ")}`)

    const readText = (value: string | Uint8Array): string => typeof value === "string" ? value : new TextDecoder().decode(value)
    const sourceManifest = parseDatasetSourceManifest(JSON.parse(readText(manifestJson)))
    const definition = parseDatasetDefinition(JSON.parse(readText(definitionJson)))
    assertDatasetIdentity(entry.id, entry.version, sourceManifest.id, sourceManifest.version, "manifest.json")
    assertDatasetIdentity(entry.id, entry.version, definition.id, definition.version, "dataset.json")
    const reference: DatasetReference = {
      kind: "project",
      id: entry.id,
      version: entry.version,
      ref: `project_${entry.id.replaceAll(".", "_")}_${entry.version.replaceAll(".", "_")}`,
    }
    const dataFiles = Object.entries(session.resources)
      .filter(([path]) => path.startsWith(`${prefix}data/`))
      .map(([path, value]) => ({
        path: path.slice(`${prefix}data/`.length),
        bytes: typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value),
      }))
    const generated: GeneratedDatasetResources = {
      manifest: sourceManifest,
      definition,
      modelDataset: entry,
      files: {
        "manifest.json": readText(manifestJson),
        "dataset.json": readText(definitionJson),
        "dataset.py": readText(python),
      },
      dataFiles,
    }
    resources.set(reference.ref, generated)
    infos.push({ reference, manifest: sourceManifest, definition })
  }
  return { infos, resources }
}

function assertDatasetIdentity(expectedId: string, expectedVersion: string, actualId: string, actualVersion: string, file: string): void {
  if (actualId !== expectedId || actualVersion !== expectedVersion) {
    throw new DatasetContractError(
      `identity must match model reference '${expectedId}@${expectedVersion}', got '${actualId}@${actualVersion}'`,
      "invalid-identity",
      `${file}.id/version`,
    )
  }
}

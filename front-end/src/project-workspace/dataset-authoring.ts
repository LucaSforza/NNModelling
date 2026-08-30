import {
  parseDatasetDefinition,
  parseDatasetSourceManifest,
  parseModelManifest,
  serializeDatasetDefinition,
  type DatasetClassMetadata,
  type DatasetDefinition,
  type DatasetParameter,
  type DatasetSourceManifest,
  type ModelDatasetReference,
  type ModelManifestV2,
} from "./dataset-contract"
import {
  ensureProjectPermission,
  normalizeProjectPath,
  type ProjectDirectoryHandle,
  type ProjectFile,
  type ProjectWorkspaceSession,
  writeProjectFiles,
} from "./index"
import type { DType, Dimension } from "../type-system/tensor-type"
import { isDType } from "../type-system/tensor-type"
import { isVersion } from "../type-system/packages/semver"

const DATASET_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
const DIRECTORY_PART = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/
const SLOT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export type DatasetSlotRequest = {
  readonly name: string
  readonly shape: readonly Dimension[]
  readonly dtype: DType
}

export type DatasetClassRequest = DatasetClassMetadata

/** The serializable form model used by DatasetManager and non-UI callers. */
export type DatasetAuthoringRequest = {
  readonly id: string
  readonly version: string
  /** A project-relative path under `datasets/`. */
  readonly directory: string
  readonly name: string
  readonly description?: string
  readonly parameters: readonly DatasetParameter[]
  readonly inputs: readonly DatasetSlotRequest[]
  readonly targets: readonly DatasetSlotRequest[]
  readonly classes?: DatasetClassRequest
  readonly inferenceAdapter?: Readonly<Record<string, unknown>>
  readonly dataFiles?: readonly DatasetDataFile[]
}

export type ValidatedDatasetAuthoringRequest = Omit<DatasetAuthoringRequest, "dataFiles"> & {
  readonly dataFiles: readonly DatasetDataFile[]
}

export type DatasetDataFile = {
  /** Path relative to the generated dataset's `data/` directory. */
  readonly path: string
  readonly bytes: Uint8Array
}

export type DatasetDataFileFeedback = {
  readonly path: string
  readonly size: number
  readonly totalSize: number
}

export type GeneratedDatasetResources = {
  readonly manifest: DatasetSourceManifest
  readonly definition: DatasetDefinition
  readonly modelDataset: ModelDatasetReference
  readonly files: Readonly<{
    readonly "manifest.json": string
    readonly "dataset.json": string
    readonly "dataset.py": string
  }>
  readonly dataFiles: readonly DatasetDataFile[]
}

/** A browser File or a test double with the same read-only surface. */
export type DatasetFileLike = Pick<ProjectFile, "arrayBuffer" | "text"> & {
  readonly name?: string
  readonly size?: number
}

/** Read a selected local file; browser File System handles are never retained. */
export async function readDatasetDataFile(
  file: DatasetFileLike,
  path = file.name,
): Promise<DatasetDataFile> {
  if (!path) throw new Error("dataset data file must have a relative path")
  const safePath = normalizeDataPath(path)
  if (file.arrayBuffer) return { path: safePath, bytes: new Uint8Array(await file.arrayBuffer()) }
  if (file.text) return { path: safePath, bytes: new TextEncoder().encode(await file.text()) }
  throw new Error(`dataset data file '${safePath}' cannot be read`)
}

/**
 * Return cumulative size information for a file picker. The UI can show this
 * before authoring, while the coordinator still validates the exact bytes.
 */
export function datasetDataFileFeedback(files: readonly DatasetDataFile[]): readonly DatasetDataFileFeedback[] {
  const totalSize = files.reduce((total, file) => total + file.bytes.byteLength, 0)
  return files.map((file) => ({ path: file.path, size: file.bytes.byteLength, totalSize }))
}

export function validateDatasetAuthoringRequest(input: DatasetAuthoringRequest): ValidatedDatasetAuthoringRequest {
  if (!input || typeof input !== "object") throw new Error("dataset authoring request must be an object")
  if (!DATASET_ID.test(input.id)) throw new Error("dataset id is invalid")
  if (!isVersion(input.version)) throw new Error("dataset version is invalid")
  const directory = validateDatasetDirectory(input.directory)
  if (typeof input.name !== "string" || !input.name.trim()) throw new Error("dataset name must not be empty")
  if (input.description !== undefined && typeof input.description !== "string") throw new Error("dataset description must be a string")
  if (!Array.isArray(input.parameters)) throw new Error("dataset parameters must be an array")
  if (!Array.isArray(input.inputs) || !Array.isArray(input.targets)) throw new Error("dataset inputs and targets must be arrays")

  const parameters = input.parameters.map((parameter, index) => {
    if (!parameter || typeof parameter !== "object") throw new Error(`dataset parameter ${index} must be an object`)
    return structuredClone(parameter)
  })
  const inputs = input.inputs.map((slot, index) => validateSlot(slot, `input slot ${index}`))
  const targets = input.targets.map((slot, index) => validateSlot(slot, `target slot ${index}`))
  const slots = new Set<string>()
  for (const slot of [...inputs, ...targets]) {
    if (slots.has(slot.name)) throw new Error(`dataset slot names must be unique: '${slot.name}'`)
    slots.add(slot.name)
  }

  const dataFiles = (input.dataFiles ?? []).map((file, index) => {
    if (!file || typeof file !== "object" || !(file.bytes instanceof Uint8Array)) throw new Error(`dataset data file ${index} must contain bytes`)
    return { path: normalizeDataPath(file.path), bytes: new Uint8Array(file.bytes) }
  })
  const dataPaths = new Set<string>()
  for (const file of dataFiles) {
    if (dataPaths.has(file.path)) throw new Error(`dataset data file paths must be unique: '${file.path}'`)
    dataPaths.add(file.path)
  }

  const classes = input.classes === undefined ? undefined : validateClasses(input.classes)
  const definition = parseDatasetDefinition({
    schemaVersion: 1,
    id: input.id,
    version: input.version,
    name: input.name,
    ...(input.description === undefined ? {} : { description: input.description }),
    parameters,
    batch: {
      inputs: Object.fromEntries(inputs.map((slot) => [slot.name, { shape: slot.shape, dtype: slot.dtype }])),
      targets: Object.fromEntries(targets.map((slot) => [slot.name, { shape: slot.shape, dtype: slot.dtype }])),
    },
    ...(classes === undefined ? {} : { classes }),
    ...(input.inferenceAdapter === undefined ? {} : { inferenceAdapter: structuredClone(input.inferenceAdapter) }),
  })
  return {
    id: input.id,
    version: input.version,
    directory,
    name: input.name,
    ...(input.description === undefined ? {} : { description: input.description }),
    parameters: definition.parameters,
    inputs,
    targets,
    ...(classes === undefined ? {} : { classes }),
    ...(input.inferenceAdapter === undefined ? {} : { inferenceAdapter: structuredClone(input.inferenceAdapter) }),
    dataFiles,
  }
}

/** Render the three editable files; `data/` is created by the transaction. */
export function generateDatasetResources(input: DatasetAuthoringRequest): GeneratedDatasetResources {
  const request = validateDatasetAuthoringRequest(input)
  const definition = parseDatasetDefinition({
    schemaVersion: 1,
    id: request.id,
    version: request.version,
    name: request.name,
    ...(request.description === undefined ? {} : { description: request.description }),
    parameters: request.parameters,
    batch: {
      inputs: Object.fromEntries(request.inputs.map((slot) => [slot.name, { shape: slot.shape, dtype: slot.dtype }])),
      targets: Object.fromEntries(request.targets.map((slot) => [slot.name, { shape: slot.shape, dtype: slot.dtype }])),
    },
    ...(request.classes === undefined ? {} : { classes: request.classes }),
    ...(request.inferenceAdapter === undefined ? {} : { inferenceAdapter: request.inferenceAdapter }),
  })
  const manifest = parseDatasetSourceManifest({
    schemaVersion: 1,
    id: request.id,
    version: request.version,
    entrypoints: { definition: "dataset.json", python: "dataset.py" },
  })
  const files = {
    "manifest.json": serializeJson(manifest),
    "dataset.json": serializeDatasetDefinition(definition),
    "dataset.py": renderDatasetPython(request, definition),
  } as const
  return {
    manifest,
    definition,
    modelDataset: { id: request.id, version: request.version, path: request.directory },
    files,
    dataFiles: request.dataFiles,
  }
}

export const createDatasetResources = generateDatasetResources
export const generateDatasetPackage = generateDatasetResources
export const createDatasetPackage = generateDatasetResources

export interface ProjectDatasetAuthoringResult {
  readonly generated: GeneratedDatasetResources
  readonly modelJson: string
}

export type ProjectDatasetAuthoringPhase = "validation" | "manifest" | "dataset-write" | "model-write" | "rollback"

export class ProjectDatasetAuthoringError extends Error {
  constructor(message: string, readonly phase: ProjectDatasetAuthoringPhase, readonly cause?: unknown) {
    super(message)
    this.name = "ProjectDatasetAuthoringError"
  }
}

export class ProjectDatasetAuthoringRollbackError extends ProjectDatasetAuthoringError {
  constructor(readonly operationError: unknown, readonly rollbackError: unknown) {
    super(`Dataset authoring failed and rollback also failed: ${messageOf(operationError)}; manual recovery required: ${messageOf(rollbackError)}`, "rollback", rollbackError)
    this.name = "ProjectDatasetAuthoringRollbackError"
  }
}

/** Serializes dataset creation and owns the exact-directory rollback receipt. */
export class ProjectDatasetAuthoringCoordinator {
  private resources: Record<string, string | Uint8Array>
  private modelJson: string
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly session: ProjectWorkspaceSession) {
    this.resources = { ...session.resources }
    this.modelJson = session.modelJson
  }

  listProjectDatasets(): readonly ModelDatasetReference[] {
    return parseModelDocument(this.modelJson).manifest.customDatasets
  }

  author(request: DatasetAuthoringRequest): Promise<ProjectDatasetAuthoringResult> {
    const operation = this.tail.then(() => this.run(request))
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async run(input: DatasetAuthoringRequest): Promise<ProjectDatasetAuthoringResult> {
    let generated: GeneratedDatasetResources
    try {
      generated = generateDatasetResources(input)
    } catch (cause) {
      throw new ProjectDatasetAuthoringError(messageOf(cause), "validation", cause)
    }

    const current = parseModelDocument(this.modelJson)
    if (current.manifest.customDatasets.some((dataset) => dataset.id === generated.modelDataset.id || dataset.path === generated.modelDataset.path)) {
      throw new ProjectDatasetAuthoringError(`Dataset '${generated.modelDataset.id}@${generated.modelDataset.version}' or path '${generated.modelDataset.path}' already exists`, "manifest")
    }
    const prefix = `${generated.modelDataset.path}/`
    if (Object.keys(this.resources).some((path) => path === generated.modelDataset.path || path.startsWith(prefix))) {
      throw new ProjectDatasetAuthoringError(`Project dataset directory '${generated.modelDataset.path}' already exists`, "manifest")
    }
    try {
      await ensureProjectPermission(this.session.directory)
    } catch (cause) {
      throw new ProjectDatasetAuthoringError(messageOf(cause), "dataset-write", cause)
    }

    const nextManifest: ModelManifestV2 = {
      ...current.manifest,
      schemaVersion: 2,
      customDatasets: [...current.manifest.customDatasets, generated.modelDataset],
    }
    const nextProject = { ...current.document, manifest: nextManifest }
    const nextModelJson = JSON.stringify(nextProject, null, 2)
    const nextResources = {
      ...this.resources,
      ...Object.fromEntries(Object.entries(generated.files).map(([path, value]) => [`${prefix}${path}`, value])),
      ...Object.fromEntries(generated.dataFiles.map((file) => [`${prefix}data/${file.path}`, file.bytes] as const)),
    }

    let created: CreatedDatasetDirectory | undefined
    let modelWriteAttempted = false
    try {
      created = await createDatasetDirectory(this.session.directory, generated.modelDataset.path)
      await created.directory.getDirectoryHandle("data", { create: true })
      await writeProjectFiles(created.directory, generated.files)
      for (const file of generated.dataFiles) await writeProjectFiles(created.directory, { [`data/${file.path}`]: file.bytes })
      modelWriteAttempted = true
      await this.session.save(nextModelJson)
    } catch (cause) {
      const rollbackErrors: unknown[] = []
      if (modelWriteAttempted) {
        try { await this.session.save(this.modelJson) } catch (rollbackCause) { rollbackErrors.push(new Error(`model restore: ${messageOf(rollbackCause)}`)) }
      }
      if (created) {
        try { await removeCreatedDatasetDirectory(created) } catch (rollbackCause) { rollbackErrors.push(new Error(`dataset removal: ${messageOf(rollbackCause)}`)) }
      }
      if (rollbackErrors.length > 0) throw new ProjectDatasetAuthoringRollbackError(cause, new Error(rollbackErrors.map(messageOf).join("; ")))
      throw new ProjectDatasetAuthoringError(messageOf(cause), modelWriteAttempted ? "model-write" : "dataset-write", cause)
    }

    this.resources = nextResources
    this.modelJson = nextModelJson
    return { generated, modelJson: nextModelJson }
  }
}

type CreatedDatasetDirectory = {
  readonly directory: ProjectDirectoryHandle
  readonly parent: ProjectDirectoryHandle
  readonly name: string
}

async function createDatasetDirectory(root: ProjectDirectoryHandle, path: string): Promise<CreatedDatasetDirectory> {
  const parts = path.split("/")
  const name = parts.pop()!
  let parent = root
  for (const part of parts) {
    try { parent = await parent.getDirectoryHandle(part) }
    catch (cause) {
      if (!isNotFoundError(cause)) throw cause
      parent = await parent.getDirectoryHandle(part, { create: true })
    }
  }
  try {
    await parent.getDirectoryHandle(name)
  } catch (cause) {
    if (!isNotFoundError(cause)) throw cause
    return { directory: await parent.getDirectoryHandle(name, { create: true }), parent, name }
  }
  throw new Error(`Project dataset directory '${path}' already exists`)
}

async function removeCreatedDatasetDirectory(created: CreatedDatasetDirectory): Promise<void> {
  if (!created.parent.removeEntry) throw new Error(`Cannot remove newly created dataset directory '${created.name}'`)
  await created.parent.removeEntry(created.name, { recursive: true })
}

function parseModelDocument(value: string): { document: Record<string, unknown>; manifest: ModelManifestV2 } {
  let document: Record<string, unknown>
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("model document must be an object")
    document = parsed as Record<string, unknown>
  } catch (cause) {
    throw new ProjectDatasetAuthoringError(`Invalid model document: ${messageOf(cause)}`, "manifest", cause)
  }
  const parsedManifest = parseModelManifest(document.manifest)
  return { document, manifest: parsedManifest.manifest }
}

function validateDatasetDirectory(directory: string): string {
  const normalized = normalizeProjectPath(directory)
  const parts = normalized.split("/")
  if (parts.length < 2 || parts[0] !== "datasets" || !parts.slice(1).every((part) => DIRECTORY_PART.test(part))) throw new Error("dataset directory must be a normalized path under datasets/")
  return normalized
}

function normalizeDataPath(path: string): string {
  const normalized = normalizeProjectPath(path)
  if (!normalized || normalized.startsWith("data/") || normalized.includes("/data/")) throw new Error("dataset data file path must be relative to data/")
  return normalized
}

function validateSlot(slot: DatasetSlotRequest, label: string): DatasetSlotRequest {
  if (!slot || typeof slot !== "object" || !SLOT_NAME.test(slot.name)) throw new Error(`${label} name is invalid`)
  if (!Array.isArray(slot.shape) || !slot.shape.every((dimension) => (typeof dimension === "number" && Number.isInteger(dimension) && dimension > 0) || (typeof dimension === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(dimension)))) throw new Error(`${label} shape is invalid`)
  if (!isDType(slot.dtype)) throw new Error(`${label} dtype is unsupported`)
  return { name: slot.name, shape: [...slot.shape], dtype: slot.dtype }
}

function validateClasses(classes: DatasetClassRequest): DatasetClassMetadata {
  if (!classes || !Number.isInteger(classes.count) || classes.count < 1) throw new Error("dataset class count must be a positive integer")
  if (classes.names !== undefined && (!Array.isArray(classes.names) || classes.names.length !== classes.count || !classes.names.every((name) => typeof name === "string" && Boolean(name.trim())))) throw new Error("dataset class names must match count")
  return { count: classes.count, ...(classes.names === undefined ? {} : { names: [...classes.names] }) }
}

function renderDatasetPython(request: ValidatedDatasetAuthoringRequest, definition: DatasetDefinition): string {
  const inputNames = Object.keys(definition.batch.inputs)
  const targetNames = Object.keys(definition.batch.targets)
  return `"""Editable project dataset scaffold for ${request.name}.

The .pt files mentioned below are only a convenient starting point. Replace
the loader with any local, deterministic implementation that returns the
named TrainingBatch contract; project data must stay below context.root.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import torch
from torch.utils.data import DataLoader, Dataset


@dataclass(frozen=True)
class DatasetContext:
    """Read-only root containing this dataset's editable data/ directory."""

    resource_root: Path


@dataclass(frozen=True)
class TrainingBatch:
    """Flat named tensor maps consumed by the compiled model."""

    inputs: Mapping[str, torch.Tensor]
    targets: Mapping[str, torch.Tensor]


class NamedTensorDataset(Dataset[TrainingBatch]):
    def __init__(self, batches: Sequence[TrainingBatch]) -> None:
        self._batches = list(batches)

    def __len__(self) -> int:
        return len(self._batches)

    def __getitem__(self, index: int) -> TrainingBatch:
        return self._batches[index]


def _load_pt_split(path: Path) -> NamedTensorDataset:
    """Load an optional split of named maps; edit this for another format."""
    if not path.is_file():
        raise FileNotFoundError(f"missing optional split file: {path.name}")
    raw: Any = torch.load(path, map_location="cpu", weights_only=False)
    if isinstance(raw, Mapping) and "inputs" in raw and "targets" in raw:
        raw = [raw]
    if not isinstance(raw, Sequence):
        raise TypeError("a .pt split must contain a sequence of named batches")
    batches: list[TrainingBatch] = []
    for item in raw:
        if not isinstance(item, Mapping) or not isinstance(item.get("inputs"), Mapping) or not isinstance(item.get("targets"), Mapping):
            raise TypeError("each split item must contain flat inputs and targets maps")
        if not all(isinstance(value, torch.Tensor) for value in item["inputs"].values()) or not all(isinstance(value, torch.Tensor) for value in item["targets"].values()):
            raise TypeError("split values must be tensors")
        batches.append(TrainingBatch(inputs=dict(item["inputs"]), targets=dict(item["targets"])))
    return NamedTensorDataset(batches)


class ProjectDataset:
    def __init__(self, splits: Mapping[str, DataLoader[TrainingBatch]]) -> None:
        self._splits = dict(splits)

    def division(self) -> Mapping[str, DataLoader[TrainingBatch]]:
        """Return train, validation and test loaders for the worker."""
        return self._splits


def build(parameters: Mapping[str, object], context: DatasetContext) -> ProjectDataset:
    """Build this dataset without importing project code in the API process."""
    del parameters
    data_root = context.resource_root / "data"
    # Optional editable starting files: data/train.pt, data/validation.pt and data/test.pt.
    split_files = {name: data_root / f"{name}.pt" for name in ("train", "validation", "test")}
    splits = {
        name: DataLoader(_load_pt_split(path), batch_size=None)
        for name, path in split_files.items()
    }
    return ProjectDataset(splits)

# Declared input slots: ${inputNames.join(", ") || "none"}
# Declared target slots: ${targetNames.join(", ") || "none"}
`
}

function serializeJson(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n` }
function isNotFoundError(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false
  const error = cause as { name?: string; code?: number | string; message?: string }
  return error.name === "NotFoundError" || error.code === 8 || error.code === "not-found" || /not found|missing/i.test(error.message ?? "")
}
function messageOf(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }

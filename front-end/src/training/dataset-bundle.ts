import type { GeneratedDatasetResources } from "../project-workspace/dataset-authoring"

/** The only archive representation accepted by the v1 dataset transport. */
export const DATASET_ARCHIVE_FORMAT = "zip" as const

export type DatasetArchiveProgress = {
  readonly phase: "encoding" | "digesting"
  readonly transferredBytes: number
  readonly totalBytes: number
}

export type DatasetArchiveBuildOptions = {
  /** Optional backend-advertised cap used for an early client-side failure. */
  readonly maxBytes?: number
  readonly onProgress?: (progress: DatasetArchiveProgress) => void
}

export type DatasetArchive = {
  readonly format: typeof DATASET_ARCHIVE_FORMAT
  readonly bytes: Uint8Array
  readonly digest: string
  readonly size: number
  readonly files: readonly string[]
}

/**
 * Build the canonical ZIP sent to the dataset upload endpoint.
 *
 * Entries are sorted, uncompressed and stamped with a zero DOS timestamp, so
 * the same dataset resource closure always produces identical bytes and a
 * stable SHA-256 digest.  This function only encodes bytes; it never runs the
 * generated Python entrypoint.
 */
export async function buildDatasetArchive(
  resources: GeneratedDatasetResources,
  options: DatasetArchiveBuildOptions | ((progress: DatasetArchiveProgress) => void) = {},
): Promise<DatasetArchive> {
  const normalizedOptions: DatasetArchiveBuildOptions = typeof options === "function"
    ? { onProgress: options }
    : options
  const files = datasetFiles(resources)
  const totalBytes = files.reduce((total, file) => total + file.bytes.byteLength, 0)
  const maxBytes = normalizedOptions.maxBytes
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) {
    throw new Error("dataset archive maxBytes must be a positive safe integer")
  }

  const archive = encodeZip(files, (transferredBytes) => {
    normalizedOptions.onProgress?.({ phase: "encoding", transferredBytes, totalBytes })
  })
  if (maxBytes !== undefined && archive.byteLength > maxBytes) {
    throw new Error(`dataset archive exceeds maximum size (${maxBytes} bytes; encoded ${archive.byteLength})`)
  }
  normalizedOptions.onProgress?.({ phase: "digesting", transferredBytes: 0, totalBytes: archive.byteLength })
  const digest = await sha256Hex(archive)
  normalizedOptions.onProgress?.({ phase: "digesting", transferredBytes: archive.byteLength, totalBytes: archive.byteLength })
  return {
    format: DATASET_ARCHIVE_FORMAT,
    bytes: archive,
    digest,
    size: archive.byteLength,
    files: files.map((file) => file.path),
  }
}

export type DatasetArchiveFile = {
  readonly path: string
  readonly bytes: Uint8Array
}

function datasetFiles(resources: GeneratedDatasetResources): DatasetArchiveFile[] {
  const files: DatasetArchiveFile[] = [
    { path: "manifest.json", bytes: textBytes(resources.files["manifest.json"]) },
    { path: "dataset.json", bytes: textBytes(resources.files["dataset.json"]) },
    { path: "dataset.py", bytes: textBytes(resources.files["dataset.py"]) },
    ...resources.dataFiles.map((file) => ({ path: `data/${file.path}`, bytes: new Uint8Array(file.bytes) })),
  ]
  const seen = new Set<string>()
  const normalized: DatasetArchiveFile[] = []
  for (const file of files) {
    const path = confinedArchivePath(file.path)
    if (seen.has(path)) throw new Error(`dataset archive contains duplicate path '${path}'`)
    seen.add(path)
    normalized.push({ path, bytes: new Uint8Array(file.bytes) })
  }
  return normalized.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}

function confinedArchivePath(path: string): string {
  if (!path || path.includes("\\") || path.includes("\x00") || path.startsWith("/")) {
    throw new Error(`dataset archive path is not confined: '${path}'`)
  }
  const parts = path.split("/")
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`dataset archive path is not confined: '${path}'`)
  }
  if (path !== "manifest.json" && path !== "dataset.json" && path !== "dataset.py" && !path.startsWith("data/")) {
    throw new Error(`dataset archive path is outside the dataset closure: '${path}'`)
  }
  return parts.join("/")
}

function encodeZip(files: readonly DatasetArchiveFile[], onFile: (bytes: number) => void): Uint8Array {
  const names = files.map((file) => new TextEncoder().encode(file.path))
  const localSize = files.reduce((total, file, index) => total + 30 + names[index]!.byteLength + file.bytes.byteLength, 0)
  const centralSize = files.reduce((total, file, index) => total + 46 + names[index]!.byteLength, 0)
  const endSize = 22
  const result = new Uint8Array(localSize + centralSize + endSize)
  const view = new DataView(result.buffer)
  const offsets: number[] = []
  let cursor = 0
  let transferred = 0
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!
    const name = names[index]!
    offsets.push(cursor)
    write32(view, cursor, 0x04034b50); write16(view, cursor + 4, 20); write16(view, cursor + 6, 0x800)
    write16(view, cursor + 8, 0); write16(view, cursor + 10, 0); write16(view, cursor + 12, 0)
    write32(view, cursor + 14, crc32(file.bytes)); write32(view, cursor + 18, file.bytes.byteLength)
    write32(view, cursor + 22, file.bytes.byteLength); write16(view, cursor + 26, name.byteLength); write16(view, cursor + 28, 0)
    result.set(name, cursor + 30); result.set(file.bytes, cursor + 30 + name.byteLength)
    cursor += 30 + name.byteLength + file.bytes.byteLength
    transferred += file.bytes.byteLength
    onFile(transferred)
  }
  const centralOffset = cursor
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!
    const name = names[index]!
    const offset = offsets[index]!
    write32(view, cursor, 0x02014b50); write16(view, cursor + 4, 20); write16(view, cursor + 6, 20)
    write16(view, cursor + 8, 0x800); write16(view, cursor + 10, 0); write16(view, cursor + 12, 0)
    write16(view, cursor + 14, 0); write32(view, cursor + 16, crc32(file.bytes)); write32(view, cursor + 20, file.bytes.byteLength)
    write32(view, cursor + 24, file.bytes.byteLength); write16(view, cursor + 28, name.byteLength); write16(view, cursor + 30, 0)
    write16(view, cursor + 32, 0); write16(view, cursor + 34, 0); write16(view, cursor + 36, 0)
    write32(view, cursor + 38, 0); write32(view, cursor + 42, offset)
    result.set(name, cursor + 46)
    cursor += 46 + name.byteLength
  }
  const centralLength = cursor - centralOffset
  write32(view, cursor, 0x06054b50); write16(view, cursor + 4, 0); write16(view, cursor + 6, 0)
  write16(view, cursor + 8, files.length); write16(view, cursor + 10, files.length); write32(view, cursor + 12, centralLength)
  write32(view, cursor + 16, centralOffset); write16(view, cursor + 20, 0)
  return result
}

function write16(view: DataView, offset: number, value: number): void { view.setUint16(offset, value, true) }
function write32(view: DataView, offset: number, value: number): void { view.setUint32(offset, value >>> 0, true) }

function textBytes(value: string): Uint8Array { return new TextEncoder().encode(value) }

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (typeof globalThis.crypto?.subtle?.digest !== "function") throw new Error("Web Crypto is required to build a dataset archive")
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

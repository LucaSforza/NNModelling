import type { PackageKey } from "./packages/types"

/** Lifecycle phase that can produce a fatal package/runtime diagnostic. */
export type PackageRuntimeDiagnosticPhase =
  | "discovery"
  | "install"
  | "validation"
  | "dependency"
  | "activation"
  | "inference"
  | "disposal"

/** Public, browser-owned representation of a package/runtime failure. */
export type PackageRuntimeDiagnostic = {
  readonly occurrenceId: string
  readonly severity: "fatal"
  readonly phase: PackageRuntimeDiagnosticPhase
  readonly message: string
  readonly packageId?: string
  readonly packageVersion?: string
  readonly nodeId?: string
  readonly fiber?: {
    readonly state?: string
    readonly context?: string
  }
}

export type PackageRuntimeDiagnosticInput = Omit<PackageRuntimeDiagnostic, "occurrenceId" | "severity"> & {
  readonly occurrenceId?: string
  readonly activationAttempt?: number
}

/** Stable identity for a refresh-level occurrence. */
export function diagnosticOccurrenceId(input: PackageRuntimeDiagnosticInput): string {
  if (input.occurrenceId) return input.occurrenceId
  const packageKey = input.packageId
    ? `${input.packageId}@${input.packageVersion ?? "?"}`
    : "runtime"
  const node = input.nodeId ?? "global"
  const attempt = input.activationAttempt === undefined ? "persistent" : String(input.activationAttempt)
  return `${input.phase}:${packageKey}:${node}:${attempt}`
}

/**
 * Small bounded collection used by editor-facing runtime owners.
 * Recording the same occurrence replaces its message/context instead of
 * appending another entry on every graph refresh.
 */
export class PackageRuntimeDiagnosticCollection {
  private readonly entries = new Map<string, PackageRuntimeDiagnostic>()

  constructor(private readonly limit = 128) {}

  record(input: PackageRuntimeDiagnosticInput): PackageRuntimeDiagnostic {
    const occurrenceId = diagnosticOccurrenceId(input)
    const diagnostic: PackageRuntimeDiagnostic = {
      occurrenceId,
      severity: "fatal",
      phase: input.phase,
      message: input.message,
      ...(input.packageId === undefined ? {} : { packageId: input.packageId }),
      ...(input.packageVersion === undefined ? {} : { packageVersion: input.packageVersion }),
      ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
      ...(input.fiber === undefined ? {} : { fiber: input.fiber }),
    }
    this.entries.delete(occurrenceId)
    this.entries.set(occurrenceId, diagnostic)
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!)
    return diagnostic
  }

  replace(input: PackageRuntimeDiagnosticInput): PackageRuntimeDiagnostic {
    return this.record(input)
  }

  resolve(occurrenceId: string): boolean {
    return this.entries.delete(occurrenceId)
  }

  resolveWhere(predicate: (diagnostic: PackageRuntimeDiagnostic) => boolean): number {
    let removed = 0
    for (const [occurrenceId, diagnostic] of this.entries) {
      if (predicate(diagnostic) && this.entries.delete(occurrenceId)) removed++
    }
    return removed
  }

  clear(): void {
    this.entries.clear()
  }

  snapshot(): readonly PackageRuntimeDiagnostic[] {
    return [...this.entries.values()]
  }

  get size(): number {
    return this.entries.size
  }
}

/** Concise helper for callers that already have an exact package key. */
export function packageDiagnosticIdentity(key: PackageKey): { packageId: string; packageVersion: string } {
  const separator = key.lastIndexOf("@")
  return {
    packageId: key.slice(0, separator),
    packageVersion: key.slice(separator + 1),
  }
}

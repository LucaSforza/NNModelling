import type { InferenceRule, Package } from "./types"

export type ActivePackage = { readonly packageInfo: Package; readonly rule: InferenceRule }

/** Cordis-visible package registry. The disposer returned by register is idempotent. */
export class PackageRegistry {
  private readonly active = new Map<string, ActivePackage>()

  register(value: ActivePackage): () => void {
    const id = value.packageInfo.manifest.id
    if (this.active.has(id)) throw new Error(`package '${id}' is already active`)
    this.active.set(id, value)
    let released = false
    return () => {
      if (released) return
      released = true
      this.active.delete(id)
    }
  }

  get(id: string): ActivePackage | undefined { return this.active.get(id) }
  has(id: string): boolean { return this.active.has(id) }
  clear(): void { this.active.clear() }
}

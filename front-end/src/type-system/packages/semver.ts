const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

type Version = { readonly major: number; readonly minor: number; readonly patch: number; readonly prerelease?: readonly string[] }

export function isVersion(value: string): boolean { return VERSION.test(value) }

export function satisfies(version: string, range: string): boolean {
  if (!isVersion(version) || !range) return false
  const actual = parse(version)
  if (!range.startsWith("^")) return isVersion(range) && compare(actual, parse(range)) === 0
  if (!isVersion(range.slice(1))) return false
  const base = parse(range.slice(1))
  if (compare(actual, base) < 0) return false
  const upper: Version = base.major > 0
    ? { major: base.major + 1, minor: 0, patch: 0 }
    : base.minor > 0
      ? { major: 0, minor: base.minor + 1, patch: 0 }
      : { major: 0, minor: 0, patch: base.patch + 1 }
  return compare(actual, upper) < 0
}

function parse(value: string): Version {
  const match = VERSION.exec(value)
  if (!match) throw new Error("invalid semantic version")
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), ...(match[4] ? { prerelease: match[4].split(".") } : {}) }
}

function compare(left: Version, right: Version): number {
  const numeric = left.major - right.major || left.minor - right.minor || left.patch - right.patch
  if (numeric) return numeric
  if (!left.prerelease) return right.prerelease ? 1 : 0
  if (!right.prerelease) return -1
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index++) {
    const a = left.prerelease[index]
    const b = right.prerelease[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue
    const aNumber = /^\d+$/.test(a)
    const bNumber = /^\d+$/.test(b)
    if (aNumber && bNumber) return Number(a) - Number(b)
    if (aNumber) return -1
    if (bNumber) return 1
    return a < b ? -1 : 1
  }
  return 0
}

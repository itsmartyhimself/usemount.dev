// Connect-gate support-matrix check (Step 5.1). Pure version logic — no IO,
// no deps. Reads a parsed package.json + a lockfile name and returns the list
// of bounded-support-matrix violations from architecture-brief §17–73. An
// empty list means the repo passes the gate.
//
// Each blocked stack maps to a concrete worker/runtime failure mode:
//   - React <19      → forward-compat boundary; iframe runtime is React 19 ESM
//   - Next <16/Vite <5 → introspection assumes modern app-shell shape
//   - Tailwind <4    → worker CSS pipeline is v4-only (REV-Plugin spike
//                      showed v3 fails through the build worker pipeline)
//   - TypeScript <5  → introspect AST shape diverges on TS 4.x
//   - No lockfile    → package-manager auto-detect requires one
//
// v1 limitation: reads the ROOT package.json only. A pnpm/yarn/npm workspace
// root with no React/Next deps would be refused even if a child workspace is
// legitimately supported. Workspace-aware scan is a Step 5 follow-up
// (surfaced in migration-log known-risks).

export type SupportMatrixField =
  | "package-json"
  | "react"
  | "next-or-vite"
  | "tailwind"
  | "typescript"
  | "lockfile"

export type SupportMatrixReason = "too-old" | "absent" | "unparseable"

export interface SupportMatrixViolation {
  field: SupportMatrixField
  required: string
  found: string | null
  reason: SupportMatrixReason
}

export interface SupportMatrixInput {
  packageJson: unknown
  lockfileName: string | null
}

// dep version strings are messy: "^19.0.0", "~14.2.0", "5", ">=4 <5",
// "git+ssh://…", "workspace:*", "npm:react@^17", "link:./pkg". We extract the
// MAJOR semver only — ranges are treated as "the lower bound's major";
// non-semver tags fall through as `unparseable` (the right user-visible
// outcome for "you can't tell us the version from this string"). Treat
// `null` / non-string as null.
const SEMVER_MAJOR_RE = /^[~^>=<\s]*v?(\d+)(?:[.\d]|$)/

export function extractMajor(version: string | undefined | null): number | null {
  if (!version || typeof version !== "string") return null
  const m = version.match(SEMVER_MAJOR_RE)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) && n >= 0 ? n : null
}

// Read a dep version from either dependencies or devDependencies — many real
// repos (this one included) put react/next/tailwind in either bucket.
function readDep(
  pkg: Record<string, unknown>,
  name: string,
): string | undefined {
  const deps =
    (pkg.dependencies as Record<string, string> | undefined) ?? {}
  const devDeps =
    (pkg.devDependencies as Record<string, string> | undefined) ?? {}
  return deps[name] ?? devDeps[name]
}

export function checkSupportMatrix(
  input: SupportMatrixInput,
): SupportMatrixViolation[] {
  const violations: SupportMatrixViolation[] = []
  const pkg =
    input.packageJson && typeof input.packageJson === "object"
      ? (input.packageJson as Record<string, unknown>)
      : null

  // Single root cause if package.json itself is missing/unreadable — surface
  // as one violation, skip the per-field checks (otherwise the user gets a
  // wall of "absent" lines for nothing actionable).
  if (!pkg) {
    return [
      {
        field: "package-json",
        required: "package.json at the repo root",
        found: null,
        reason: "absent",
      },
    ]
  }

  // React 19+
  const reactRaw = readDep(pkg, "react")
  if (!reactRaw) {
    violations.push({
      field: "react",
      required: "React v19+",
      found: null,
      reason: "absent",
    })
  } else {
    const major = extractMajor(reactRaw)
    if (major === null) {
      violations.push({
        field: "react",
        required: "React v19+",
        found: reactRaw,
        reason: "unparseable",
      })
    } else if (major < 19) {
      violations.push({
        field: "react",
        required: "React v19+",
        found: `v${major} (${reactRaw})`,
        reason: "too-old",
      })
    }
  }

  // Next 16+ OR Vite 5+ (at least one must satisfy). If BOTH are absent →
  // "absent"; if both present but neither satisfies → "too-old" picks the one
  // that's actually present (next preferred); unparseable in only one of two
  // is still pass if the other satisfies.
  const nextRaw = readDep(pkg, "next")
  const viteRaw = readDep(pkg, "vite")
  const nextMajor = nextRaw ? extractMajor(nextRaw) : null
  const viteMajor = viteRaw ? extractMajor(viteRaw) : null
  const nextOk = nextMajor !== null && nextMajor >= 16
  const viteOk = viteMajor !== null && viteMajor >= 5
  if (!nextOk && !viteOk) {
    if (!nextRaw && !viteRaw) {
      violations.push({
        field: "next-or-vite",
        required: "Next.js v16+ or Vite v5+",
        found: null,
        reason: "absent",
      })
    } else if (nextRaw && nextMajor === null) {
      violations.push({
        field: "next-or-vite",
        required: "Next.js v16+ or Vite v5+",
        found: `Next.js ${nextRaw}`,
        reason: "unparseable",
      })
    } else if (viteRaw && viteMajor === null && !nextRaw) {
      violations.push({
        field: "next-or-vite",
        required: "Next.js v16+ or Vite v5+",
        found: `Vite ${viteRaw}`,
        reason: "unparseable",
      })
    } else {
      const found = nextRaw
        ? `Next.js v${nextMajor} (${nextRaw})`
        : `Vite v${viteMajor} (${viteRaw})`
      violations.push({
        field: "next-or-vite",
        required: "Next.js v16+ or Vite v5+",
        found,
        reason: "too-old",
      })
    }
  }

  // Tailwind v4+
  const tailwindRaw = readDep(pkg, "tailwindcss")
  if (!tailwindRaw) {
    violations.push({
      field: "tailwind",
      required: "Tailwind CSS v4+",
      found: null,
      reason: "absent",
    })
  } else {
    const major = extractMajor(tailwindRaw)
    if (major === null) {
      violations.push({
        field: "tailwind",
        required: "Tailwind CSS v4+",
        found: tailwindRaw,
        reason: "unparseable",
      })
    } else if (major < 4) {
      violations.push({
        field: "tailwind",
        required: "Tailwind CSS v4+",
        found: `v${major} (${tailwindRaw})`,
        reason: "too-old",
      })
    }
  }

  // TypeScript v5+
  const tsRaw = readDep(pkg, "typescript")
  if (!tsRaw) {
    violations.push({
      field: "typescript",
      required: "TypeScript v5+",
      found: null,
      reason: "absent",
    })
  } else {
    const major = extractMajor(tsRaw)
    if (major === null) {
      violations.push({
        field: "typescript",
        required: "TypeScript v5+",
        found: tsRaw,
        reason: "unparseable",
      })
    } else if (major < 5) {
      violations.push({
        field: "typescript",
        required: "TypeScript v5+",
        found: `v${major} (${tsRaw})`,
        reason: "too-old",
      })
    }
  }

  // Lockfile present (any of the four supported package managers). The
  // caller resolves the lockfile name from a single root listing — we just
  // need a non-null value here.
  if (!input.lockfileName) {
    violations.push({
      field: "lockfile",
      required:
        "a lockfile (pnpm-lock.yaml, package-lock.json, yarn.lock, bun.lock, or bun.lockb)",
      found: null,
      reason: "absent",
    })
  }

  return violations
}

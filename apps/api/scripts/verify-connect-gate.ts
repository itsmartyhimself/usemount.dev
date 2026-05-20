import {
  checkSupportMatrix,
  extractMajor,
} from "../src/github/support-matrix.js"

// In-process verification harness for the connect-gate (PR9 / Step 5.1).
//
// support-matrix.ts is a pure function — no IO, no Octokit, no DB. The
// harness exhaustively exercises:
//   - extractMajor() across realistic version-string shapes (^, ~, ranges,
//     exact, prefix-v, prerelease tags, npm: aliases, git+ssh, workspace:*)
//   - checkSupportMatrix() happy paths (Next + Vite) and every refusal axis
//   - edge cases (null packageJson, missing react/next/tailwind/typescript,
//     boundary versions, future versions, unparseable strings)
//
// Sentinel range 999_999_999_951 / 999_999_999_952 is reserved for future
// PR9 cases that need live state — unused in v1 because the function is
// pure. This keeps the range distinct from PR5 (...91/92), PR6 (...81/82/83),
// PR7 (...971), PR8 (...961).

type Case = { ok: boolean; label: string; detail?: string }
const cases: Case[] = []

function assert(label: string, ok: boolean, detail?: string): void {
  cases.push({ ok, label, detail })
  console.log(
    `  ${ok ? "✓" : "✗"} ${label}${ok ? "" : detail ? ` — ${detail}` : ""}`,
  )
}

function expectEq<T>(label: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  assert(
    label,
    ok,
    ok
      ? undefined
      : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  )
}

console.log("=== PR9 verify:connect-gate ===\n")

// ── extractMajor() ────────────────────────────────────────────────────────
console.log("--- extractMajor() ---")
expectEq("extractMajor('^19.0.0') = 19", extractMajor("^19.0.0"), 19)
expectEq("extractMajor('~14.2.0') = 14", extractMajor("~14.2.0"), 14)
expectEq("extractMajor('5') = 5", extractMajor("5"), 5)
expectEq("extractMajor('5.0.0') = 5", extractMajor("5.0.0"), 5)
expectEq("extractMajor('v19.0.0') = 19", extractMajor("v19.0.0"), 19)
expectEq(
  "extractMajor('>=4.0.0 <5.0.0') = 4",
  extractMajor(">=4.0.0 <5.0.0"),
  4,
)
expectEq(
  "extractMajor('19.0.0-rc.1') = 19",
  extractMajor("19.0.0-rc.1"),
  19,
)
expectEq(
  "extractMajor('git+ssh://example.com/foo.git') = null",
  extractMajor("git+ssh://example.com/foo.git"),
  null,
)
expectEq(
  "extractMajor('workspace:*') = null",
  extractMajor("workspace:*"),
  null,
)
expectEq(
  "extractMajor('npm:react@^17.0.0') = null",
  extractMajor("npm:react@^17.0.0"),
  null,
)
expectEq("extractMajor('') = null", extractMajor(""), null)
expectEq("extractMajor(undefined) = null", extractMajor(undefined), null)
expectEq("extractMajor(null) = null", extractMajor(null), null)
console.log("")

// ── checkSupportMatrix happy paths ────────────────────────────────────────
console.log("--- happy paths ---")
{
  const v = checkSupportMatrix({
    packageJson: {
      dependencies: { react: "^19.0.0", next: "^16.0.0" },
      devDependencies: { tailwindcss: "^4.0.0", typescript: "^5.0.0" },
    },
    lockfileName: "pnpm-lock.yaml",
  })
  expectEq(
    "Next 16 + React 19 + Tailwind 4 + TS 5 + pnpm = 0 violations",
    v,
    [],
  )
}
{
  const v = checkSupportMatrix({
    packageJson: {
      dependencies: { react: "^19.0.0", vite: "^5.0.0" },
      devDependencies: { tailwindcss: "^4.0.0", typescript: "^5.0.0" },
    },
    lockfileName: "package-lock.json",
  })
  expectEq(
    "Vite 5 + React 19 + Tailwind 4 + TS 5 + npm = 0 violations",
    v,
    [],
  )
}
{
  const v = checkSupportMatrix({
    packageJson: {
      devDependencies: {
        react: "^19.0.0",
        next: "^16.0.0",
        tailwindcss: "^4.0.0",
        typescript: "^5.0.0",
      },
    },
    lockfileName: "yarn.lock",
  })
  expectEq("All deps in devDependencies (yarn) = pass", v, [])
}
{
  const v = checkSupportMatrix({
    packageJson: {
      dependencies: {
        react: "^25.0.0",
        next: "^20.0.0",
      },
      devDependencies: { tailwindcss: "^9.0.0", typescript: "^7.0.0" },
    },
    lockfileName: "bun.lockb",
  })
  expectEq(
    "Future major versions (no upper bound) + bun.lockb = pass",
    v,
    [],
  )
}
{
  const v = checkSupportMatrix({
    packageJson: {
      dependencies: { react: "^19.0.0", next: "^14.2.0", vite: "^5.0.0" },
      devDependencies: { tailwindcss: "^4.0.0", typescript: "^5.0.0" },
    },
    lockfileName: "pnpm-lock.yaml",
  })
  expectEq(
    "Vite 5 OK overrides Next 14 too-old (either-or check)",
    v,
    [],
  )
}
console.log("")

// ── per-field refusals ────────────────────────────────────────────────────
console.log("--- per-field refusals ---")
{
  const v = checkSupportMatrix({
    packageJson: {
      dependencies: { react: "^17.0.2", next: "^16.0.0" },
      devDependencies: { tailwindcss: "^4.0.0", typescript: "^5.0.0" },
    },
    lockfileName: "pnpm-lock.yaml",
  })
  assert(
    "React 17 → exactly one too-old react violation",
    v.length === 1 && v[0].field === "react" && v[0].reason === "too-old",
  )
}
{
  const v = checkSupportMatrix({
    packageJson: {
      dependencies: { react: "^18.3.1", next: "^16.0.0" },
      devDependencies: { tailwindcss: "^4.0.0", typescript: "^5.0.0" },
    },
    lockfileName: "pnpm-lock.yaml",
  })
  assert(
    "React 18 → too-old (boundary check, 18 < 19)",
    v.length === 1 && v[0].field === "react" && v[0].reason === "too-old",
  )
}
{
  const v = checkSupportMatrix({
    packageJson: {
      dependencies: { next: "^16.0.0" },
      devDependencies: { tailwindcss: "^4.0.0", typescript: "^5.0.0" },
    },
    lockfileName: "pnpm-lock.yaml",
  })
  assert(
    "React missing → exactly one absent react violation",
    v.length === 1 && v[0].field === "react" && v[0].reason === "absent",
  )
}
{
  const v = checkSupportMatrix({
    packageJson: {
      dependencies: { react: "^19.0.0", next: "^14.2.0" },
      devDependencies: { tailwindcss: "^4.0.0", typescript: "^5.0.0" },
    },
    lockfileName: "pnpm-lock.yaml",
  })
  assert(
    "Next 14 alone → exactly one too-old next-or-vite violation",
    v.length === 1 &&
      v[0].field === "next-or-vite" &&
      v[0].reason === "too-old",
  )
}
{
  const v = checkSupportMatrix({
    packageJson: {
      dependencies: { react: "^19.0.0", vite: "^4.0.0" },
      devDependencies: { tailwindcss: "^4.0.0", typescript: "^5.0.0" },
    },
    lockfileName: "pnpm-lock.yaml",
  })
  assert(
    "Vite 4 alone → exactly one too-old next-or-vite violation",
    v.length === 1 &&
      v[0].field === "next-or-vite" &&
      v[0].reason === "too-old",
  )
}
{
  const v = checkSupportMatrix({
    packageJson: {
      dependencies: { react: "^19.0.0" },
      devDependencies: { tailwindcss: "^4.0.0", typescript: "^5.0.0" },
    },
    lockfileName: "pnpm-lock.yaml",
  })
  assert(
    "Neither Next nor Vite → absent next-or-vite violation",
    v.length === 1 &&
      v[0].field === "next-or-vite" &&
      v[0].reason === "absent",
  )
}
{
  const v = checkSupportMatrix({
    packageJson: {
      dependencies: { react: "^19.0.0", next: "^16.0.0" },
      devDependencies: { tailwindcss: "^3.4.1", typescript: "^5.0.0" },
    },
    lockfileName: "pnpm-lock.yaml",
  })
  assert(
    "Tailwind 3 → too-old (load-bearing for worker CSS pipeline)",
    v.length === 1 && v[0].field === "tailwind" && v[0].reason === "too-old",
  )
}
{
  const v = checkSupportMatrix({
    packageJson: {
      dependencies: { react: "^19.0.0", next: "^16.0.0" },
      devDependencies: { tailwindcss: "^4.0.0", typescript: "^4.9.5" },
    },
    lockfileName: "pnpm-lock.yaml",
  })
  assert(
    "TypeScript 4 → too-old (AST shape diverges)",
    v.length === 1 &&
      v[0].field === "typescript" &&
      v[0].reason === "too-old",
  )
}
{
  const v = checkSupportMatrix({
    packageJson: {
      dependencies: { react: "^19.0.0", next: "^16.0.0" },
      devDependencies: { tailwindcss: "^4.0.0", typescript: "^5.0.0" },
    },
    lockfileName: null,
  })
  assert(
    "No lockfile → absent lockfile violation",
    v.length === 1 && v[0].field === "lockfile" && v[0].reason === "absent",
  )
}
{
  const v = checkSupportMatrix({
    packageJson: {
      dependencies: { react: "git+ssh://example.com/react.git", next: "^16.0.0" },
      devDependencies: { tailwindcss: "^4.0.0", typescript: "^5.0.0" },
    },
    lockfileName: "pnpm-lock.yaml",
  })
  assert(
    "React git+ssh → unparseable",
    v.length === 1 && v[0].field === "react" && v[0].reason === "unparseable",
  )
}
console.log("")

// ── all-axes-failing refusal ──────────────────────────────────────────────
console.log("--- combined refusals ---")
{
  const v = checkSupportMatrix({
    packageJson: {
      dependencies: { react: "^17.0.2", next: "^14.2.0" },
      devDependencies: { tailwindcss: "^3.4.1", typescript: "^4.9.5" },
    },
    lockfileName: null,
  })
  assert(
    "Tailwind 3 + Next 14 + React 17 + TS 4 + no lockfile = 5 violations",
    v.length === 5,
  )
  assert(
    "  …includes react too-old",
    v.some((x) => x.field === "react" && x.reason === "too-old"),
  )
  assert(
    "  …includes next-or-vite too-old",
    v.some((x) => x.field === "next-or-vite" && x.reason === "too-old"),
  )
  assert(
    "  …includes tailwind too-old",
    v.some((x) => x.field === "tailwind" && x.reason === "too-old"),
  )
  assert(
    "  …includes typescript too-old",
    v.some((x) => x.field === "typescript" && x.reason === "too-old"),
  )
  assert(
    "  …includes lockfile absent",
    v.some((x) => x.field === "lockfile" && x.reason === "absent"),
  )
}
console.log("")

// ── edge cases ────────────────────────────────────────────────────────────
console.log("--- edge cases ---")
{
  const v = checkSupportMatrix({
    packageJson: null,
    lockfileName: "pnpm-lock.yaml",
  })
  assert(
    "null packageJson → single package-json absent (root cause)",
    v.length === 1 &&
      v[0].field === "package-json" &&
      v[0].reason === "absent",
  )
}
{
  const v = checkSupportMatrix({
    packageJson: "not-an-object",
    lockfileName: "pnpm-lock.yaml",
  })
  assert(
    "string packageJson → single package-json absent",
    v.length === 1 &&
      v[0].field === "package-json" &&
      v[0].reason === "absent",
  )
}
{
  const v = checkSupportMatrix({
    packageJson: {},
    lockfileName: "pnpm-lock.yaml",
  })
  assert(
    "empty {} packageJson + lockfile = 4 absent violations",
    v.length === 4 && v.every((x) => x.reason === "absent"),
  )
}
{
  const v = checkSupportMatrix({
    packageJson: { dependencies: null, devDependencies: null },
    lockfileName: "pnpm-lock.yaml",
  })
  assert(
    "deps + devDeps both null = 4 absent violations",
    v.length === 4 && v.every((x) => x.reason === "absent"),
  )
}
{
  const v = checkSupportMatrix({
    packageJson: {
      dependencies: { react: "19.0.0", next: "16.0.0" },
      devDependencies: { tailwindcss: "4.0.0", typescript: "5.0.0" },
    },
    lockfileName: "pnpm-lock.yaml",
  })
  expectEq("Exact versions (no caret/tilde) = pass", v, [])
}
console.log("")

const passed = cases.filter((c) => c.ok).length
const failed = cases.length - passed
console.log(
  `=== ${passed}/${cases.length} pass${failed > 0 ? `, ${failed} FAIL` : ""} ===`,
)
if (failed > 0) process.exit(1)

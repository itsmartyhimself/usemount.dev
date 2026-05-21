// PR12 verification harness — Step 5.5 component preset override parser.
//
// In-process exercises of resolveComponentPresets (apps/api/src/build/
// component-presets.ts) — the literal-only AST parser for a sibling
// `<Component>.usemount.tsx` file. Mirrors the mount-config.ts security
// posture: AST-only, never evaluates customer code, fail-closed on
// non-literals (the offending preset is skipped, never run).
//
// Matrix:
//   - sibling path resolution (Button.tsx → Button.usemount.tsx)
//   - no override file → {} presets, no hints
//   - happy path: multiple presets, scalar props
//   - all literal kinds: string / number / negative / boolean / null /
//     nested object / array / no-substitution template
//   - non-literals rejected: identifier ref, call expression, JSX,
//     template with substitution
//   - partial: valid presets kept, invalid skipped (+ hint)
//   - wrong export shape / missing export → {} + hint
//   - string-literal preset keys with spaces
//   - never throws on malformed input
//
// No DB sentinels — the parser is pure (file-system reads only).
//
// Run with: pnpm --filter @usemount/api verify:presets
// Exits non-zero on any failed assertion. Cleanup in a finally block.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  resolveComponentPresets,
  presetFilePath,
} from "../src/build/component-presets.js"

interface Case {
  name: string
  ok: boolean
  detail?: string
}
const cases: Case[] = []
function assert(name: string, ok: boolean, detail?: string): void {
  cases.push({ name, ok, detail })
  if (!ok) {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  } else {
    console.log(`  ✓ ${name}`)
  }
}

function makeWorkDir(): string {
  return mkdtempSync(path.join(tmpdir(), "usemount-verify-presets-"))
}

const TMPDIRS: string[] = []
function track(dir: string): string {
  TMPDIRS.push(dir)
  return dir
}

/** Write a sibling override file and return the component entry path to parse. */
function withOverride(contents: string): string {
  const dir = track(makeWorkDir())
  mkdirSync(dir, { recursive: true })
  const entry = path.join(dir, "Button.tsx")
  writeFileSync(path.join(dir, "Button.usemount.tsx"), contents, "utf8")
  return entry
}

function cleanup(): void {
  for (const dir of TMPDIRS) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
}

try {
  // ── case 1: sibling path resolution ─────────────────────────────────────
  {
    assert(
      "case 1.a — Button.tsx → Button.usemount.tsx",
      presetFilePath("/repo/components/Button.tsx") ===
        path.join("/repo/components", "Button.usemount.tsx"),
    )
    assert(
      "case 1.b — nested path preserved",
      presetFilePath("/a/b/c/Card.tsx") === path.join("/a/b/c", "Card.usemount.tsx"),
    )
  }

  // ── case 2: no override file → {} presets, no hints ─────────────────────
  {
    const dir = track(makeWorkDir())
    const r = resolveComponentPresets(path.join(dir, "Button.tsx"))
    assert("case 2.a — no presets", Object.keys(r.presets).length === 0)
    assert("case 2.b — no hints (silent when file absent)", r.hints.length === 0)
  }

  // ── case 3: happy path — multiple presets, scalar props ─────────────────
  {
    const entry = withOverride(
      [
        `export const presets = {`,
        `  "Primary Large": { variant: "primary", size: "lg" },`,
        `  "Danger": { variant: "danger", disabled: true },`,
        `}`,
      ].join("\n"),
    )
    const r = resolveComponentPresets(entry)
    assert(
      "case 3.a — both presets parsed",
      Object.keys(r.presets).length === 2,
    )
    assert(
      "case 3.b — string-literal key with space preserved",
      r.presets["Primary Large"]?.variant === "primary" &&
        r.presets["Primary Large"]?.size === "lg",
    )
    assert(
      "case 3.c — boolean prop value",
      r.presets["Danger"]?.disabled === true,
    )
    assert("case 3.d — no hints on clean parse", r.hints.length === 0)
  }

  // ── case 4: all literal kinds ───────────────────────────────────────────
  {
    const entry = withOverride(
      [
        `export const presets = {`,
        `  All: {`,
        `    str: "x",`,
        `    tmpl: \`y\`,`,
        `    num: 42,`,
        `    neg: -5,`,
        `    yes: true,`,
        `    no: false,`,
        `    nothing: null,`,
        `    nested: { a: 1, b: "two" },`,
        `    list: [1, "a", false],`,
        `  },`,
        `}`,
      ].join("\n"),
    )
    const r = resolveComponentPresets(entry)
    const p = r.presets["All"]
    assert("case 4.a — string", p?.str === "x")
    assert("case 4.b — no-substitution template → string", p?.tmpl === "y")
    assert("case 4.c — number", p?.num === 42)
    assert("case 4.d — negative number", p?.neg === -5)
    assert("case 4.e — true", p?.yes === true)
    assert("case 4.f — false", p?.no === false)
    assert("case 4.g — null", p?.nothing === null)
    assert(
      "case 4.h — nested object literal",
      !!p && typeof p.nested === "object" &&
        (p.nested as Record<string, unknown>).a === 1 &&
        (p.nested as Record<string, unknown>).b === "two",
    )
    assert(
      "case 4.i — array literal",
      Array.isArray(p?.list) &&
        (p!.list as unknown[]).length === 3 &&
        (p!.list as unknown[])[1] === "a",
    )
    assert("case 4.j — clean parse, no hints", r.hints.length === 0)
  }

  // ── case 5: non-literal value (variable reference) → preset skipped ─────
  {
    const entry = withOverride(
      [
        `const shared = "primary"`,
        `export const presets = {`,
        `  Bad: { variant: shared },`,
        `}`,
      ].join("\n"),
    )
    const r = resolveComponentPresets(entry)
    assert("case 5.a — identifier-ref preset skipped", !r.presets["Bad"])
    assert(
      "case 5.b — hint names the skipped preset + prop",
      r.hints.some((h) => h.includes('"Bad"') && h.includes("variant")),
    )
  }

  // ── case 6: call-expression value → skipped (never evaluated) ───────────
  {
    const entry = withOverride(
      [
        `export const presets = {`,
        `  Bad: { when: Date.now() },`,
        `}`,
      ].join("\n"),
    )
    const r = resolveComponentPresets(entry)
    assert("case 6.a — call-expression preset skipped", !r.presets["Bad"])
    assert("case 6.b — hint emitted", r.hints.length > 0)
  }

  // ── case 7: JSX value → skipped (slots out of scope) ────────────────────
  {
    const entry = withOverride(
      [
        `export const presets = {`,
        `  Bad: { icon: <svg /> },`,
        `}`,
      ].join("\n"),
    )
    const r = resolveComponentPresets(entry)
    assert("case 7.a — JSX preset skipped", !r.presets["Bad"])
    assert("case 7.b — hint emitted", r.hints.length > 0)
  }

  // ── case 8: template with substitution → skipped ────────────────────────
  {
    const entry = withOverride(
      [
        "const x = 1",
        "export const presets = {",
        "  Bad: { label: `count ${x}` },",
        "}",
      ].join("\n"),
    )
    const r = resolveComponentPresets(entry)
    assert("case 8.a — substituted template skipped", !r.presets["Bad"])
    assert("case 8.b — hint emitted", r.hints.length > 0)
  }

  // ── case 9: partial — valid kept, invalid skipped ───────────────────────
  {
    const entry = withOverride(
      [
        `const ref = "x"`,
        `export const presets = {`,
        `  Good: { variant: "primary" },`,
        `  Bad: { variant: ref },`,
        `}`,
      ].join("\n"),
    )
    const r = resolveComponentPresets(entry)
    assert("case 9.a — valid preset kept", r.presets["Good"]?.variant === "primary")
    assert("case 9.b — invalid preset dropped", !r.presets["Bad"])
    assert("case 9.c — exactly one preset", Object.keys(r.presets).length === 1)
    assert("case 9.d — one hint for the skipped preset", r.hints.length === 1)
  }

  // ── case 10: preset value not an object literal → skipped ───────────────
  {
    const entry = withOverride(
      [
        `export const presets = {`,
        `  Bad: "primary",`,
        `  Good: { variant: "primary" },`,
        `}`,
      ].join("\n"),
    )
    const r = resolveComponentPresets(entry)
    assert("case 10.a — non-object preset skipped", !r.presets["Bad"])
    assert("case 10.b — object preset kept", !!r.presets["Good"])
    assert(
      "case 10.c — hint says value must be a props object",
      r.hints.some((h) => h.includes("props object")),
    )
  }

  // ── case 11: wrong export shape / missing export → {} + hint ────────────
  {
    const entry1 = withOverride(`export const presets = "nope"\n`)
    const r1 = resolveComponentPresets(entry1)
    assert("case 11.a — non-object presets export → {}", Object.keys(r1.presets).length === 0)
    assert("case 11.b — hint says must be object literal", r1.hints.some((h) => h.includes("object literal")))

    const entry2 = withOverride(`export const other = { Good: { x: 1 } }\n`)
    const r2 = resolveComponentPresets(entry2)
    assert("case 11.c — missing `presets` export → {}", Object.keys(r2.presets).length === 0)
    assert("case 11.d — hint names the missing export", r2.hints.some((h) => h.includes("export const presets")))
  }

  // ── case 12: malformed source never throws ──────────────────────────────
  {
    const entry = withOverride(`export const presets = { Good: { x: 1 } ,,, <<<\n`)
    let threw = false
    let r
    try {
      r = resolveComponentPresets(entry)
    } catch {
      threw = true
    }
    assert("case 12.a — malformed file does not throw", !threw)
    assert("case 12.b — degrades to a result object", !!r)
  }
} finally {
  cleanup()
}

const total = cases.length
const passed = cases.filter((c) => c.ok).length
console.log(`\nverify-presets: ${passed}/${total} passed`)
if (passed !== total) {
  process.exit(1)
}

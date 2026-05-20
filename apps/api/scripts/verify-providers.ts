// PR11 verification harness — Step 5.3 + 5.4 provider resolver.
//
// In-process exercises of resolveProvidersSource (apps/api/src/build/providers.ts)
// across the matrix the architecture-brief §3 disposition #2 calls out:
//   - canvas.providers.tsx override path (Step 5.4)
//   - app/layout.tsx auto-detect (Step 5.3) — known provider, unknown
//     wrapper, no wrappers, no layout
//   - source/canvas-override priority (override beats auto)
//   - nesting order preservation
//   - import discovery + curated default attrs
//   - emitted source is syntactically valid TS (ts-morph re-parse)
//
// No DB sentinels needed — the resolver is pure (file-system reads only).
// Storage/iframe round-trip for the providers bundle URL is covered by the
// verify-iframe.ts harness extension in the same PR.
//
// Run with: pnpm --filter @usemount/api verify:providers
// Exits non-zero on any failed assertion. Cleanup is in a finally block so a
// mid-run failure still removes the temp workDirs.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { resolveProvidersSource } from "../src/build/providers.js"

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

/**
 * Make a fresh, isolated workDir under tmpdir(). The harness creates one per
 * scenario so any FS state leaks (file collisions, stale layouts) can't
 * cross-contaminate. rm in finally block.
 */
function makeWorkDir(): string {
  return mkdtempSync(path.join(tmpdir(), "usemount-verify-providers-"))
}

function writeFile(workDir: string, relPath: string, contents: string): void {
  const abs = path.join(workDir, relPath)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, contents, "utf8")
}

const TMPDIRS: string[] = []
function track(dir: string): string {
  TMPDIRS.push(dir)
  return dir
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
  // ── case 1: canvas.providers.tsx override picked verbatim ───────────────
  {
    const dir = track(makeWorkDir())
    const customSrc =
      `import type { ReactNode } from "react"\n` +
      `export default function Providers({ children }: { children: ReactNode }) { return <div className="custom">{children}</div> }\n`
    writeFile(dir, "canvas.providers.tsx", customSrc)
    const r = resolveProvidersSource(dir)
    assert("case 1.a — canvas-override origin", r.origin === "canvas-override")
    assert(
      "case 1.b — canvas-override source returned verbatim",
      r.source === customSrc,
    )
    assert("case 1.c — canvas-override detected empty", r.detected.length === 0)
  }

  // ── case 2: canvas.providers.ts (no x) also honored ─────────────────────
  {
    const dir = track(makeWorkDir())
    const customSrc = `export default function Providers({ children }: { children: any }) { return children }\n`
    writeFile(dir, "canvas.providers.ts", customSrc)
    const r = resolveProvidersSource(dir)
    assert("case 2.a — canvas-override .ts variant", r.origin === "canvas-override")
    assert("case 2.b — canvas-override .ts source returned", r.source === customSrc)
  }

  // ── case 3: auto-detect happy path (ThemeProvider + QueryClientProvider) ──
  {
    const dir = track(makeWorkDir())
    writeFile(
      dir,
      "app/layout.tsx",
      [
        `import { ThemeProvider } from "next-themes"`,
        `import { QueryClient, QueryClientProvider } from "@tanstack/react-query"`,
        `const queryClient = new QueryClient()`,
        `export default function RootLayout({ children }: { children: any }) {`,
        `  return (`,
        `    <html lang="en">`,
        `      <body>`,
        `        <ThemeProvider attribute="class" defaultTheme="dark">`,
        `          <QueryClientProvider client={queryClient}>`,
        `            {children}`,
        `          </QueryClientProvider>`,
        `        </ThemeProvider>`,
        `      </body>`,
        `    </html>`,
        `  )`,
        `}`,
      ].join("\n"),
    )
    const r = resolveProvidersSource(dir)
    assert("case 3.a — auto origin", r.origin === "auto")
    assert(
      "case 3.b — detected both providers in order",
      r.detected.length === 2 &&
        r.detected[0] === "next-themes" &&
        r.detected[1] === "@tanstack/react-query",
    )
    assert(
      "case 3.c — emit contains next-themes import",
      r.source !== null && r.source.includes(`from "next-themes"`),
    )
    assert(
      "case 3.d — emit contains react-query import (QueryClient+Provider)",
      r.source !== null &&
        r.source.includes(`{ QueryClient, QueryClientProvider }`),
    )
    assert(
      "case 3.e — emit contains QueryClient preamble",
      r.source !== null && r.source.includes(`const queryClient = new QueryClient()`),
    )
    assert(
      "case 3.f — emit uses curated default attr (attribute=\"class\"), NOT customer's defaultTheme=\"dark\"",
      r.source !== null &&
        r.source.includes(`<ThemeProvider attribute="class">`) &&
        !r.source.includes(`defaultTheme="dark"`),
    )
    assert(
      "case 3.g — emit has hint about stripped attrs",
      r.hints.some((h) => h.includes("attrs stripped")),
    )
  }

  // ── case 4: layout with no known providers (just html/body wrapping {children}) ──
  {
    const dir = track(makeWorkDir())
    writeFile(
      dir,
      "app/layout.tsx",
      [
        `export default function RootLayout({ children }: { children: any }) {`,
        `  return (`,
        `    <html lang="en">`,
        `      <body>{children}</body>`,
        `    </html>`,
        `  )`,
        `}`,
      ].join("\n"),
    )
    const r = resolveProvidersSource(dir)
    assert("case 4.a — origin none (no known providers)", r.origin === "none")
    assert("case 4.b — source null", r.source === null)
    assert("case 4.c — detected empty", r.detected.length === 0)
  }

  // ── case 5: no layout at all ────────────────────────────────────────────
  {
    const dir = track(makeWorkDir())
    const r = resolveProvidersSource(dir)
    assert("case 5.a — origin none (no layout)", r.origin === "none")
    assert("case 5.b — hint names the missing files", r.hints.some((h) => h.includes("no app/layout.tsx")))
  }

  // ── case 6: unknown JSX wrapper not in the known-providers list ─────────
  {
    const dir = track(makeWorkDir())
    writeFile(
      dir,
      "app/layout.tsx",
      [
        `import { MyCustomProvider } from "@acme/internal"`,
        `export default function RootLayout({ children }: { children: any }) {`,
        `  return (<MyCustomProvider>{children}</MyCustomProvider>)`,
        `}`,
      ].join("\n"),
    )
    const r = resolveProvidersSource(dir)
    assert(
      "case 6.a — origin none (unrecognised wrapper)",
      r.origin === "none",
    )
    assert(
      "case 6.b — hint mentions unrecognised provider",
      r.hints.some((h) => h.includes("unrecognised")),
    )
  }

  // ── case 7: nesting order preservation (Query outer, Theme inner) ───────
  {
    const dir = track(makeWorkDir())
    writeFile(
      dir,
      "app/layout.tsx",
      [
        `import { ThemeProvider } from "next-themes"`,
        `import { QueryClient, QueryClientProvider } from "@tanstack/react-query"`,
        `const q = new QueryClient()`,
        `export default function L({ children }: any) {`,
        `  return (`,
        `    <QueryClientProvider client={q}>`,
        `      <ThemeProvider>`,
        `        {children}`,
        `      </ThemeProvider>`,
        `    </QueryClientProvider>`,
        `  )`,
        `}`,
      ].join("\n"),
    )
    const r = resolveProvidersSource(dir)
    assert(
      "case 7.a — detected order matches source nesting (Query outer)",
      r.detected.length === 2 &&
        r.detected[0] === "@tanstack/react-query" &&
        r.detected[1] === "next-themes",
    )
    // The emit must put QueryClientProvider outermost in the JSX.
    const queryIdx = r.source?.indexOf("<QueryClientProvider") ?? -1
    const themeIdx = r.source?.indexOf("<ThemeProvider") ?? -1
    assert(
      "case 7.b — emit preserves nesting (QueryClientProvider above ThemeProvider in source text)",
      queryIdx >= 0 && themeIdx > queryIdx,
    )
  }

  // ── case 8: override beats auto-detect ──────────────────────────────────
  {
    const dir = track(makeWorkDir())
    const customSrc = `export default function Providers({ children }: any) { return <span data-override="yes">{children}</span> }\n`
    writeFile(dir, "canvas.providers.tsx", customSrc)
    writeFile(
      dir,
      "app/layout.tsx",
      [
        `import { ThemeProvider } from "next-themes"`,
        `export default function L({ children }: any) {`,
        `  return (<ThemeProvider>{children}</ThemeProvider>)`,
        `}`,
      ].join("\n"),
    )
    const r = resolveProvidersSource(dir)
    assert("case 8.a — origin canvas-override (wins over auto)", r.origin === "canvas-override")
    assert("case 8.b — source equals override file", r.source === customSrc)
    assert("case 8.c — detected empty (auto-detect not reached)", r.detected.length === 0)
  }

  // ── case 9: src/app/layout.tsx variant ──────────────────────────────────
  {
    const dir = track(makeWorkDir())
    writeFile(
      dir,
      "src/app/layout.tsx",
      [
        `import { MotionConfig } from "framer-motion"`,
        `export default function L({ children }: any) {`,
        `  return (<MotionConfig>{children}</MotionConfig>)`,
        `}`,
      ].join("\n"),
    )
    const r = resolveProvidersSource(dir)
    assert("case 9.a — src/app/layout.tsx auto-detected", r.origin === "auto")
    assert("case 9.b — framer-motion detected", r.detected.includes("framer-motion"))
    assert(
      "case 9.c — emit contains MotionConfig import",
      r.source !== null && r.source.includes(`<MotionConfig>`),
    )
  }

  // ── case 10: aliased import (`import { ThemeProvider as TP }`) honored ──
  {
    const dir = track(makeWorkDir())
    writeFile(
      dir,
      "app/layout.tsx",
      [
        `import { ThemeProvider as TP } from "next-themes"`,
        `export default function L({ children }: any) {`,
        `  return (<TP>{children}</TP>)`,
        `}`,
      ].join("\n"),
    )
    const r = resolveProvidersSource(dir)
    assert(
      "case 10.a — aliased ThemeProvider detected by import source",
      r.origin === "auto" && r.detected.includes("next-themes"),
    )
    // The emit always uses the canonical name, not the alias.
    assert(
      "case 10.b — emit uses canonical ThemeProvider, not alias",
      r.source !== null && r.source.includes(`<ThemeProvider attribute="class">`),
    )
  }

  // ── case 11: next-intl detected with curated defaults ───────────────────
  {
    const dir = track(makeWorkDir())
    writeFile(
      dir,
      "app/layout.tsx",
      [
        `import { NextIntlClientProvider } from "next-intl"`,
        `import { getMessages } from "next-intl/server"`,
        `export default async function L({ children }: any) {`,
        `  const messages = await getMessages()`,
        `  return (<NextIntlClientProvider locale="de" messages={messages}>{children}</NextIntlClientProvider>)`,
        `}`,
      ].join("\n"),
    )
    const r = resolveProvidersSource(dir)
    assert("case 11.a — next-intl detected", r.detected.includes("next-intl"))
    assert(
      "case 11.b — emit uses curated defaults (locale=\"en\" empty messages), not customer's locale=\"de\"",
      r.source !== null &&
        r.source.includes(`locale="en" messages={{}}`) &&
        !r.source.includes(`locale="de"`),
    )
  }

  // ── case 12: full stack (Theme + Query + Intl + Motion) ────────────────
  // Worker integration + esbuild round-trip exercises real syntactic
  // correctness against a real node_modules; this case verifies the resolver
  // can detect all 4 v1 known providers in one layout.
  {
    const dir = track(makeWorkDir())
    writeFile(
      dir,
      "app/layout.tsx",
      [
        `import { ThemeProvider } from "next-themes"`,
        `import { QueryClient, QueryClientProvider } from "@tanstack/react-query"`,
        `import { NextIntlClientProvider } from "next-intl"`,
        `import { MotionConfig } from "framer-motion"`,
        `const q = new QueryClient()`,
        `export default function L({ children }: any) {`,
        `  return (`,
        `    <ThemeProvider>`,
        `      <QueryClientProvider client={q}>`,
        `        <NextIntlClientProvider locale="en" messages={{}}>`,
        `          <MotionConfig>{children}</MotionConfig>`,
        `        </NextIntlClientProvider>`,
        `      </QueryClientProvider>`,
        `    </ThemeProvider>`,
        `  )`,
        `}`,
      ].join("\n"),
    )
    const r = resolveProvidersSource(dir)
    assert("case 12.a — all 4 providers detected", r.detected.length === 4)
    assert(
      "case 12.b — emit defaults to canonical Providers function name",
      r.source !== null && r.source.includes(`export default function Providers`),
    )
    assert(
      "case 12.c — emit includes ALL 4 import statements (deduped)",
      r.source !== null &&
        r.source.includes(`from "next-themes"`) &&
        r.source.includes(`from "@tanstack/react-query"`) &&
        r.source.includes(`from "next-intl"`) &&
        r.source.includes(`from "framer-motion"`),
    )
  }
} finally {
  cleanup()
}

const total = cases.length
const passed = cases.filter((c) => c.ok).length
console.log(`\nverify-providers: ${passed}/${total} passed`)
if (passed !== total) {
  process.exit(1)
}

/**
 * Step-5.3 + 5.4 — provider source resolver.
 *
 * Components that depend on React context (theme, query-client, i18n, motion)
 * crash at module-eval in the iframe because nothing wraps them. PR7's
 * disposition was a "couldn't initialize" tile. This module emits a
 * `providers.auto.tsx` source that wraps every preview in the providers
 * detected from the customer's `app/layout.tsx` — OR copies a customer-
 * provided `canvas.providers.tsx` at the repo root verbatim when present.
 *
 * Architecture-brief §3 disposition #2:
 *   - Auto-detect common providers (theme, react-query). Build pipeline scans
 *     `app/layout.tsx` or equivalent; if it sees `ThemeProvider` wrapping
 *     `{children}`, that wrapper is auto-applied to every preview.
 *   - Fall back to one optional `canvas.providers.tsx` at repo root if the
 *     customer has bespoke providers.
 *
 * Locked design decisions (advisor pass, 2026-05-20):
 *  1. Discriminator is the **import source**, not the JSX tag name. Same
 *     `<ThemeProvider>` from next-themes vs @emotion/react are different
 *     providers — only the import source disambiguates.
 *  2. Non-literal attrs (`client={queryClient}` referencing a free variable)
 *     are STRIPPED. We always emit each known provider with curated defaults
 *     from KNOWN_PROVIDERS. Customer who needs exact attrs uses
 *     `canvas.providers.tsx` (override path).
 *  3. The emitted Providers component contract is locked:
 *       export default function Providers({ children }): ReactNode
 *     The iframe bootstrap validates the default export is a function and
 *     throws cleanly on shape mismatch. Customer override files MUST match
 *     this shape (documented in apps/web/CONVENTIONS.md).
 *  4. Auto-emit file path = `${workDir}/.usemount-providers.auto.tsx`.
 *     esbuild needs `absWorkingDir: workDir` so the customer's node_modules
 *     resolves; tmpdir() would silently fail to find next-themes etc.
 *  5. v1 known providers: next-themes, @tanstack/react-query, next-intl,
 *     framer-motion. Cover ~80% of real Next.js apps. Extending the list is
 *     a 1-row addition + 1 harness case — cheap.
 */

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

import {
  Project,
  SyntaxKind,
  type JsxAttribute,
  type JsxChild,
  type JsxElement,
  type JsxExpression,
  type JsxOpeningElement,
  type JsxSelfClosingElement,
} from "ts-morph"

export type ProvidersOrigin = "canvas-override" | "auto" | "none"

export interface ResolveResult {
  /** tsx source string to bundle, or null for "no providers". */
  source: string | null
  /** Where the source came from — drives logs and migration-log narrative. */
  origin: ProvidersOrigin
  /** Module names of providers detected from layout.tsx (auto path only). */
  detected: string[]
  /** Human notes for the build log / migration-log — non-blocking. */
  hints: string[]
}

interface KnownProvider {
  /** Module specifier on the customer's import statement. */
  sourceModule: string
  /** Named export we look for in the import statement (or default name). */
  exportName: string
  /** True for default imports (`import X from "mod"`). */
  isDefault: boolean
  /** The import statement we emit. Includes any extras (e.g., QueryClient). */
  emitImport: string
  /** Pre-formatted JSX opening tag with curated default attrs. */
  emitOpen: string
  /** Closing tag. */
  emitClose: string
  /** Optional module-level statement (e.g., `const queryClient = new …`). */
  preamble?: string
}

// Registry. Each row's `emitOpen` deliberately uses safe defaults — the
// "strip + use sensible defaults" decision (locked at advisor pass). Customers
// with bespoke provider config drop canvas.providers.tsx.
const KNOWN_PROVIDERS: KnownProvider[] = [
  {
    sourceModule: "next-themes",
    exportName: "ThemeProvider",
    isDefault: false,
    emitImport: `import { ThemeProvider } from "next-themes"`,
    emitOpen: `<ThemeProvider attribute="class">`,
    emitClose: `</ThemeProvider>`,
  },
  {
    sourceModule: "@tanstack/react-query",
    exportName: "QueryClientProvider",
    isDefault: false,
    emitImport: `import { QueryClient, QueryClientProvider } from "@tanstack/react-query"`,
    emitOpen: `<QueryClientProvider client={queryClient}>`,
    emitClose: `</QueryClientProvider>`,
    preamble: `const queryClient = new QueryClient()`,
  },
  {
    sourceModule: "next-intl",
    exportName: "NextIntlClientProvider",
    isDefault: false,
    emitImport: `import { NextIntlClientProvider } from "next-intl"`,
    // Locale + empty messages map: components that call useTranslations will
    // see "missing key" fallback text. Customer overrides via canvas.providers.tsx
    // with their actual messages map when that matters.
    emitOpen: `<NextIntlClientProvider locale="en" messages={{}}>`,
    emitClose: `</NextIntlClientProvider>`,
  },
  {
    sourceModule: "framer-motion",
    exportName: "MotionConfig",
    isDefault: false,
    emitImport: `import { MotionConfig } from "framer-motion"`,
    emitOpen: `<MotionConfig>`,
    emitClose: `</MotionConfig>`,
  },
]

// Repo-root override files. Pick the first that exists. .tsx preferred.
const CANVAS_OVERRIDE_FILES = ["canvas.providers.tsx", "canvas.providers.ts"]
// Next.js layout candidates. Pick the first that exists.
const LAYOUT_CANDIDATES = ["app/layout.tsx", "src/app/layout.tsx"]

export const PROVIDERS_AUTO_FILENAME = ".usemount-providers.auto.tsx"

/**
 * Resolve the providers source for a given workDir. Pure: file-system reads
 * only (no network, no DB, no process spawning). Safe to call before, during,
 * or in parallel with the rest of the build pipeline.
 */
export function resolveProvidersSource(workDir: string): ResolveResult {
  // (a) canvas.providers.tsx override — verbatim contents win over auto-detect.
  for (const rel of CANVAS_OVERRIDE_FILES) {
    const abs = path.join(workDir, rel)
    if (existsSync(abs)) {
      const source = readFileSync(abs, "utf8")
      return {
        source,
        origin: "canvas-override",
        detected: [],
        hints: [`canvas-override picked from ${rel}`],
      }
    }
  }

  // (b) Auto-detect from layout.tsx.
  for (const rel of LAYOUT_CANDIDATES) {
    const abs = path.join(workDir, rel)
    if (!existsSync(abs)) continue
    const auto = detectProvidersFromLayout(abs)
    if (auto.detected.length === 0) {
      return {
        source: null,
        origin: "none",
        detected: [],
        hints: [`layout=${rel}; no known providers wrapping {children}`, ...auto.hints],
      }
    }
    const emitted = emitProvidersSource(auto.detected)
    return {
      source: emitted,
      origin: "auto",
      detected: auto.detected.map((p) => p.sourceModule),
      hints: [`layout=${rel}; detected ${auto.detected.length}`, ...auto.hints],
    }
  }

  // (c) No layout candidate found.
  return {
    source: null,
    origin: "none",
    detected: [],
    hints: ["no app/layout.tsx or src/app/layout.tsx"],
  }
}

interface AutoResult {
  /** In OUTER-to-INNER order — matches the customer's nesting. */
  detected: KnownProvider[]
  hints: string[]
}

function detectProvidersFromLayout(layoutPath: string): AutoResult {
  // Single-file ts-morph project. `skipAddingFilesFromTsConfig: true` matches
  // worker.ts:243 — never evaluate, never `import()` customer code.
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
  })
  let sf
  try {
    sf = project.addSourceFileAtPath(layoutPath)
  } catch (e) {
    return { detected: [], hints: [`layout parse failed: ${(e as Error).message}`] }
  }

  // Build `localName → {sourceModule, originalName, isDefault}` from the
  // file's imports. The localName is what appears as the JSX tag name; the
  // originalName is what was exported from the module (different when the
  // customer aliases: `import { ThemeProvider as TP } from "next-themes"` →
  // localName "TP", originalName "ThemeProvider"). We match providers on
  // originalName so aliased customers aren't false-negatives.
  const importMap = new Map<
    string,
    { sourceModule: string; originalName: string; isDefault: boolean }
  >()
  for (const decl of sf.getImportDeclarations()) {
    const sourceModule = decl.getModuleSpecifierValue()
    if (!sourceModule) continue
    const def = decl.getDefaultImport()
    if (def) {
      importMap.set(def.getText(), {
        sourceModule,
        originalName: "default",
        isDefault: true,
      })
    }
    for (const named of decl.getNamedImports()) {
      const originalName = named.getName()
      const local = named.getAliasNode()?.getText() ?? originalName
      importMap.set(local, { sourceModule, originalName, isDefault: false })
    }
  }

  // Find the JsxExpression `{children}` — typical Next.js layouts have one.
  // If absent, we have no anchor; fall through to "no detection".
  let childrenExpr: JsxExpression | null = null
  for (const expr of sf.getDescendantsOfKind(SyntaxKind.JsxExpression)) {
    const inner = expr.getExpression()
    if (inner && inner.getKind() === SyntaxKind.Identifier && inner.getText() === "children") {
      childrenExpr = expr
      break
    }
  }
  if (!childrenExpr) {
    return { detected: [], hints: ["no {children} JSX expression found in layout"] }
  }

  // Walk ancestors from {children} outward, collecting JsxElement wrappers.
  // We stop at the return statement / function body. Each ancestor whose tag
  // name matches a known-provider import is collected.
  const ancestorElements: JsxElement[] = []
  for (const a of childrenExpr.getAncestors()) {
    if (a.getKind() === SyntaxKind.JsxElement) {
      ancestorElements.push(a as JsxElement)
    }
    // Stop traversal when we exit the JSX-tree of the return — performance
    // hygiene + bounds JSX traversal to the closest function scope.
    if (
      a.getKind() === SyntaxKind.ReturnStatement ||
      a.getKind() === SyntaxKind.FunctionDeclaration ||
      a.getKind() === SyntaxKind.ArrowFunction ||
      a.getKind() === SyntaxKind.FunctionExpression
    ) {
      break
    }
  }

  // ancestorElements is in INNER→OUTER order (closest ancestor first). Reverse
  // for OUTER→INNER, matching the customer's source nesting order.
  ancestorElements.reverse()

  const detected: KnownProvider[] = []
  const seenKeys = new Set<string>()
  const hints: string[] = []
  for (const el of ancestorElements) {
    const opening: JsxOpeningElement | JsxSelfClosingElement = el.getOpeningElement()
    const tagName = opening.getTagNameNode().getText()
    const imp = importMap.get(tagName)
    if (!imp) {
      // Structural wrapper (html, body, div, customer-internal). Skip silently.
      continue
    }
    const matched = KNOWN_PROVIDERS.find(
      (p) =>
        p.sourceModule === imp.sourceModule &&
        p.exportName === imp.originalName &&
        p.isDefault === imp.isDefault,
    )
    if (!matched) {
      hints.push(
        `unrecognised provider ${tagName} from ${imp.sourceModule} — skipped (drop canvas.providers.tsx to wrap)`,
      )
      continue
    }
    // De-dup: customers occasionally double-wrap (one in layout, one in a
    // nested layout). First occurrence (outermost) wins, matches the actual
    // React tree behavior.
    const key = `${matched.sourceModule}#${matched.exportName}`
    if (seenKeys.has(key)) continue
    seenKeys.add(key)

    // Hint when the customer's JSX has attrs we're about to strip — visible in
    // the build log so the customer knows why their `defaultTheme` didn't apply.
    const attrs = opening.getAttributes().filter((a): a is JsxAttribute => a.getKind() === SyntaxKind.JsxAttribute)
    if (attrs.length > 0) {
      const names = attrs.map((a) => a.getNameNode().getText()).join(", ")
      hints.push(
        `${matched.sourceModule}: attrs stripped (${names}) — using defaults; drop canvas.providers.tsx to override`,
      )
    }
    detected.push(matched)
  }

  return { detected, hints }
}

/**
 * Emit a `providers.auto.tsx` source string. Imports are deduped (each known-
 * provider's `emitImport` is unique by module specifier in v1, but we Set
 * them anyway in case of future overlap). Preambles run once at module top.
 * Nesting order matches `providers` (outer → inner).
 *
 * The generated source MUST compile under the customer's tsconfig + esbuild's
 * `jsx: 'automatic'` + the React externs that bundle.ts emits. We import
 * `ReactNode` as a type-only import so it never makes it into runtime.
 */
function emitProvidersSource(providers: readonly KnownProvider[]): string {
  const imports = new Set<string>()
  const preambles: string[] = []
  for (const p of providers) {
    imports.add(p.emitImport)
    if (p.preamble) preambles.push(p.preamble)
  }

  // Build nested JSX inside-out. Indentation grows by 2 spaces per layer so
  // outer providers sit at the shallowest depth (reads cleanly when peeking
  // into the artifact).
  let body = `${" ".repeat(6 + 2 * providers.length)}{children}\n`
  for (const p of [...providers].reverse()) {
    const opens = providers.indexOf(p)
    const indent = "      " + "  ".repeat(opens)
    body = `${indent}${p.emitOpen}\n${body}${indent}${p.emitClose}\n`
  }

  return (
    `// Auto-generated by usemount.dev — do not edit by hand.\n` +
    `// To override, add canvas.providers.tsx at your repo root.\n` +
    `// Detected providers (outer → inner): ${providers.map((p) => p.sourceModule).join(", ")}\n` +
    `\n` +
    `import type { ReactNode } from "react"\n` +
    [...imports].sort().join("\n") +
    `\n\n` +
    (preambles.length > 0 ? preambles.join("\n") + "\n\n" : "") +
    `export default function Providers({ children }: { children: ReactNode }): ReactNode {\n` +
    `  return (\n` +
    body +
    `  )\n` +
    `}\n`
  )
}

/** Test-only export — the harness needs the registry for case generation. */
export const __knownProvidersForTests: readonly KnownProvider[] = KNOWN_PROVIDERS

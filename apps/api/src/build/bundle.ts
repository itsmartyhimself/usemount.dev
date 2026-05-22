// Per-component esbuild bundler + globals.css extraction.
//
// Inherits the customer's `compilerOptions.paths` via esbuild's `tsconfig`
// option (architecture-brief §287). The PR4 spike's `alias:{'@':ALIAS_BASE}`
// shortcut is intentionally NOT here — customer codebases with `~components/*`
// aliases would silently fail otherwise and look like component bugs.
//
// React is `external` — the iframe runtime (4.3) supplies it, so we don't
// double-bundle. `format: esm` so the iframe loader can `import()` it.
//
// CSS: per-component import-driven extraction (`loader: '.css': 'css'` makes
// esbuild emit a sibling .css from any component-imported stylesheets), AND a
// separate single-shot bundle for the customer's globals.css. Tailwind v4 +
// globals.css is the v1 support matrix (architecture-brief §17–73,
// dashboard-build-plan Step 4 confirmed).

import { build } from "esbuild"
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import path from "node:path"

// CJS/ESM interop for packages resolved out of the customer's clone via
// createRequire — `require` may hand back the function directly or a { default }
// wrapper depending on how the package was authored.
function interopDefault<T>(mod: T): T {
  return (mod as { default?: T }).default ?? mod
}

export interface BundleResult {
  jsBytes: Uint8Array
  cssBytes: Uint8Array | null
}

export async function bundleComponent(opts: {
  entry: string
  workDir: string
  tsconfigPath: string
}): Promise<BundleResult> {
  const out = await build({
    entryPoints: [opts.entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    tsconfig: opts.tsconfigPath,
    external: ["react", "react-dom", "react/jsx-runtime"],
    minify: true,
    absWorkingDir: opts.workDir,
    logLevel: "silent",
    loader: { ".css": "css" },
  })
  let jsBytes: Uint8Array | null = null
  let cssBytes: Uint8Array | null = null
  for (const f of out.outputFiles) {
    if (f.path.endsWith(".css")) cssBytes = f.contents
    else jsBytes = f.contents
  }
  if (!jsBytes) throw new Error("esbuild produced no JS output")
  return { jsBytes, cssBytes }
}

/**
 * Step-5.3 providers bundle. The auto-emit (or customer-provided
 * canvas.providers.tsx) compiles through the SAME externals as component
 * bundles — React + jsx-runtime are supplied by the iframe runtime — but the
 * providers pipeline has NO `.css` loader. A canvas.providers.tsx that
 * imports CSS will fail esbuild, the worker catches the error and falls back
 * to bare-render (PR7 behavior). Customer styles for the provider tree
 * belong in globals.css. Documented in apps/web/CONVENTIONS.md.
 */
export async function bundleProviders(opts: {
  entry: string
  workDir: string
  tsconfigPath: string
}): Promise<Uint8Array> {
  const out = await build({
    entryPoints: [opts.entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    tsconfig: opts.tsconfigPath,
    external: ["react", "react-dom", "react/jsx-runtime"],
    minify: true,
    absWorkingDir: opts.workDir,
    logLevel: "silent",
    // Deliberately no `.css` loader — providers CSS is dropped (v1 limitation).
  })
  const jsFile = out.outputFiles.find((f) => !f.path.endsWith(".css"))
  if (!jsFile) throw new Error("esbuild produced no JS output for providers")
  return jsFile.contents
}

/**
 * Compile the customer's globals.css with their installed Tailwind v4 engine.
 *
 * esbuild's `.css` loader does NOT run Tailwind — it can't resolve
 * `@import "tailwindcss"` (throws `Could not resolve "tailwindcss"`) and emits
 * nothing usable, so every component rendered unstyled. Instead we run the
 * customer's own `@tailwindcss/postcss` through postcss, both resolved from the
 * CLONE's node_modules (installDeps already ran), so the engine version matches
 * their lockfile and their `@theme`/content config is honoured.
 *
 * The customer's `postcss.config.*` is intentionally bypassed: only
 * `@tailwindcss/postcss` runs (autoprefixer and other plugins are skipped).
 * Tailwind v4 is self-sufficient for the v1 support matrix; honouring the full
 * postcss chain is a follow-up.
 *
 * Two paths are anchored to the clone, NOT process.cwd (the worker process runs
 * outside the clone): `base` tells Tailwind v4 which directory to scan for class
 * candidates (it DEFAULTS to process.cwd — leaving it unset makes the worker
 * scan the wrong tree, bloating or mis-scoping the output), and `from` is the
 * absolute globals.css path for `@import`/`@source` resolution. Verified
 * cwd-independent: same byte-for-byte output whether cwd is the clone or not.
 *
 * Output is NOT minified (parity with the PR16-proven recipe); `optimize` would
 * pull in lightningcss's native binary — a follow-up once the worker runs live.
 */
export async function bundleGlobalsCss(opts: {
  globalsCssPath: string
  workDir: string
}): Promise<Uint8Array> {
  const requireFromClone = createRequire(path.join(opts.workDir, "noop.js"))
  const postcss = interopDefault(requireFromClone("postcss")) as (
    plugins: unknown[],
  ) => { process: (css: string, o: { from: string; to: string }) => PromiseLike<{ css: string }> }
  const tailwindcss = interopDefault(requireFromClone("@tailwindcss/postcss")) as (
    opts?: { base?: string },
  ) => unknown
  const src = readFileSync(opts.globalsCssPath, "utf8")
  const result = await postcss([tailwindcss({ base: opts.workDir })]).process(src, {
    from: opts.globalsCssPath,
    to: opts.globalsCssPath,
  })
  return Buffer.from(result.css)
}

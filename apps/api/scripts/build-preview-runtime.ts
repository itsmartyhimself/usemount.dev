// Build the iframe preview runtime — ESM versions of React + ReactDOM + the
// JSX runtime, served as static assets from `apps/web/public/preview-runtime/`
// and loaded by the iframe HTML (Step 4.3) via an inline importmap.
//
// Why this lives in apps/api (not apps/web): apps/api already has the build
// toolchain (esbuild + tsx) as devDeps; adding them to apps/web would be a
// net new manifest entry for code that runs once-per-React-bump. The script
// targets apps/web's node_modules (where react/react-dom are direct deps) via
// `absWorkingDir`, and writes into apps/web/public/preview-runtime/.
//
// Why self-host: PR6 bundles each customer component with `external:
// ['react','react-dom','react/jsx-runtime']` (apps/api/src/build/bundle.ts) so
// the bundle stays small (~150KB for Button) and one React runs per iframe
// document. The iframe MUST supply React; the host's React is invisible
// across the opaque-origin sandbox. esm.sh would widen CSP (script-src AND
// connect-src for chain-loads) and adds an external uptime dep — self-hosting
// keeps the iframe CSP at `script-src 'self' <storage-host>`.
//
// Idempotent: run via `pnpm --filter @usemount/api build:preview-runtime`.
// Output files are checked into the repo (small, ~150KB total minified).
// Re-run when bumping React.

import { build } from "esbuild"
import { mkdirSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// scripts/ → ../ = apps/api → ../../ = repo root → web = apps/web
const WEB_ROOT = path.resolve(__dirname, "../../web")
const OUT_DIR = path.join(WEB_ROOT, "public/preview-runtime")

// React/React-DOM live in apps/web's node_modules (direct deps there). Resolve
// from WEB_ROOT so we can read each module's real named-export set at build
// time (see buildOne) — keeps the shim in sync across React bumps.
const webRequire = createRequire(path.join(WEB_ROOT, "noop.js"))
const VALID_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

interface Target {
  name: string
  entryPoint: string
}

const TARGETS: Target[] = [
  { name: "react.mjs", entryPoint: "react" },
  { name: "react-dom.mjs", entryPoint: "react-dom" },
  { name: "react-dom-client.mjs", entryPoint: "react-dom/client" },
  { name: "react-jsx-runtime.mjs", entryPoint: "react/jsx-runtime" },
]

async function buildOne(t: Target): Promise<{ name: string; size: number }> {
  // esbuild bundling a bare CJS entry (`react`, `react-dom/client`, …) with
  // `format: "esm"` emits ONLY `export default <module.exports>` — it does NOT
  // synthesize named exports from CommonJS. But every consumer imports NAMED
  // bindings: the iframe bootstrap (`import { createRoot } from
  // "react-dom/client"`; `import * as React` then `React.createElement`) and
  // each customer bundle's automatic JSX (`import { jsx } from
  // "react/jsx-runtime"`, externalized in bundle.ts). A default-only module
  // makes all of those link-fail ("does not provide an export named
  // 'createRoot'") → React never loads → blank canvas. So we bundle a shim that
  // statically re-exports each real named binding. The names are read from the
  // installed module so the shim can't drift when React is bumped.
  const mod = webRequire(t.entryPoint) as Record<string, unknown>
  const names = Object.keys(mod).filter(
    (k) => k !== "default" && VALID_IDENT.test(k),
  )
  const shim = [
    `import __m from ${JSON.stringify(t.entryPoint)}`,
    `export default __m`,
    ...names.map((n) => `export const ${n} = __m[${JSON.stringify(n)}]`),
  ].join("\n")

  const out = await build({
    stdin: {
      contents: shim,
      // Resolve `import __m from "<entry>"` against apps/web's node_modules.
      resolveDir: WEB_ROOT,
      sourcefile: `${t.name}.shim.js`,
      loader: "js",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    minify: true,
    target: ["es2022"],
    absWorkingDir: WEB_ROOT,
    logLevel: "silent",
    // The iframe is a production environment; force the production React
    // build (no dev warnings panel). The host devtools still surface
    // postMessage `error` payloads.
    define: { "process.env.NODE_ENV": '"production"' },
    external: [],
  })
  const file = out.outputFiles[0]
  if (!file) throw new Error(`no output for ${t.entryPoint}`)
  const outPath = path.join(OUT_DIR, t.name)
  writeFileSync(outPath, file.contents)
  return { name: t.name, size: file.contents.byteLength }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true })
  const t0 = Date.now()
  const results = await Promise.all(TARGETS.map(buildOne))
  const totalMs = Date.now() - t0
  const totalBytes = results.reduce((a, r) => a + r.size, 0)
  for (const r of results) {
    console.log(`  ${r.name.padEnd(28)} ${formatBytes(r.size).padStart(10)}`)
  }
  console.log(
    `\nbuilt ${results.length} files (${formatBytes(totalBytes)}) in ${totalMs}ms`,
  )
}

main().catch((e) => {
  console.error(`[build-preview-runtime] ${(e as Error).message}`)
  process.exit(1)
})

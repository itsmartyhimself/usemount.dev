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
// Output: ONE bundle `react-runtime.mjs` (holds a single shared React) plus
// four thin `export *` stubs (react.mjs, react-dom.mjs, react-dom-client.mjs,
// react-jsx-runtime.mjs) the importmap points at. All five are checked into the
// repo. Idempotent: run via `pnpm --filter @usemount/api build:preview-runtime`.
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
// time (see buildRuntimeShim) — keeps the re-exports in sync across React bumps.
const webRequire = createRequire(path.join(WEB_ROOT, "noop.js"))
const VALID_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

// The four CommonJS packages the iframe importmap exposes, in dedupe-priority
// order: the first source to define a name wins (Fragment/version → react,
// createRoot/hydrateRoot → react-dom/client, jsx/jsxs → react/jsx-runtime).
const RUNTIME_SOURCES: { local: string; spec: string }[] = [
  { local: "__react", spec: "react" },
  { local: "__reactDom", spec: "react-dom" },
  { local: "__reactDomClient", spec: "react-dom/client" },
  { local: "__jsxRuntime", spec: "react/jsx-runtime" },
]

// The single bundle that holds ONE React. The importmap-facing files below are
// thin static re-exports of it. NOTE: a component importing `react` transitively
// loads this whole ~190KB file — that is INTENTIONAL, not waste. The iframe needs
// the reconciler to render anything, so the bytes are consolidated into one cached
// file (exactly how a normal app bundles react + react-dom deduped). Do NOT split
// it apart to "save bytes" on the react.mjs entry — that reintroduces the
// multiple-React dispatcher bug ("Cannot read properties of null (useContext)").
const RUNTIME_FILE = "react-runtime.mjs"

// Importmap entry files. Each re-exports the one runtime, so react /
// react-dom / react-dom/client / react/jsx-runtime resolve to the SAME React
// instance — the invariant that makes hooks work (see buildRuntimeShim).
const ENTRY_FILES = [
  "react.mjs",
  "react-dom.mjs",
  "react-dom-client.mjs",
  "react-jsx-runtime.mjs",
]

// Source for the combined runtime: import all four CJS packages (esbuild's
// `import x from "<cjs>"` gives x = module.exports) and statically re-export
// every unique named binding. Why ONE bundle instead of four:
//
//   esbuild can't synthesize named exports from a CJS entry (you get only
//   `export default`), so each consumer's NAMED import (the bootstrap's
//   `import { createRoot }`, `import * as React` → React.createElement; the
//   customer bundle's automatic `import { jsx }`) needs an explicit re-export.
//   AND every preview module must share ONE React: react-dom sets React's hook
//   dispatcher on its React; a second copy → hooks read a null dispatcher
//   ("Cannot read properties of null (reading 'useContext')"). Bundling all
//   four together makes esbuild dedupe React to a single instance. Splitting
//   React back out with `external` does NOT work — esbuild leaves a dynamic
//   `require("react")` inside React's CJS wrapper that throws in browser ESM.
function buildRuntimeShim(): string {
  const seen = new Set<string>(["default"])
  const importLines = RUNTIME_SOURCES.map(
    ({ local, spec }) => `import ${local} from ${JSON.stringify(spec)}`,
  )
  const exportLines: string[] = []
  for (const { local, spec } of RUNTIME_SOURCES) {
    const mod = webRequire(spec) as Record<string, unknown>
    for (const name of Object.keys(mod)) {
      if (seen.has(name) || !VALID_IDENT.test(name)) continue
      seen.add(name)
      exportLines.push(`export const ${name} = ${local}[${JSON.stringify(name)}]`)
    }
  }
  return [...importLines, ...exportLines].join("\n")
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true })
  const t0 = Date.now()

  // 1. Build the single shared runtime — one React, all named exports.
  const out = await build({
    stdin: {
      contents: buildRuntimeShim(),
      // Resolve the four bare imports against apps/web's node_modules.
      resolveDir: WEB_ROOT,
      sourcefile: "react-runtime.shim.js",
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
    // Production React build (no dev warning machinery); host devtools still
    // surface postMessage `error` payloads.
    define: { "process.env.NODE_ENV": '"production"' },
    external: [],
  })
  const file = out.outputFiles[0]
  if (!file) throw new Error("esbuild produced no output for the runtime shim")
  writeFileSync(path.join(OUT_DIR, RUNTIME_FILE), file.contents)
  console.log(
    `  ${RUNTIME_FILE.padEnd(28)} ${formatBytes(file.contents.byteLength).padStart(10)}`,
  )

  // 2. Write the thin importmap entries — `export *` is a STATIC re-export, so
  //    named imports (`{ createRoot }`, `{ jsx }`) resolve through to the
  //    runtime, and all four specifiers share its single React.
  const reExport = `export * from "./${RUNTIME_FILE}"\n`
  for (const name of ENTRY_FILES) {
    writeFileSync(path.join(OUT_DIR, name), reExport)
    console.log(`  ${name.padEnd(28)} ${formatBytes(reExport.length).padStart(10)} (re-export)`)
  }

  console.log(`\nbuilt ${ENTRY_FILES.length + 1} files in ${Date.now() - t0}ms`)
}

main().catch((e) => {
  console.error(`[build-preview-runtime] ${(e as Error).message}`)
  process.exit(1)
})

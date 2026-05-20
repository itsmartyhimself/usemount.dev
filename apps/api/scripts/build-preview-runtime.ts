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
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// scripts/ → ../ = apps/api → ../../ = repo root → web = apps/web
const WEB_ROOT = path.resolve(__dirname, "../../web")
const OUT_DIR = path.join(WEB_ROOT, "public/preview-runtime")

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
  const out = await build({
    entryPoints: [t.entryPoint],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    minify: true,
    target: ["es2022"],
    // Resolve from apps/web — that's where React/React-DOM are direct deps.
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

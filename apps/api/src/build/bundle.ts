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

export async function bundleGlobalsCss(opts: {
  globalsCssPath: string
  workDir: string
  tsconfigPath: string
}): Promise<Uint8Array> {
  const out = await build({
    entryPoints: [opts.globalsCssPath],
    bundle: true,
    write: false,
    tsconfig: opts.tsconfigPath,
    absWorkingDir: opts.workDir,
    logLevel: "silent",
    minify: true,
    loader: { ".css": "css" },
  })
  const cssFile = out.outputFiles.find((f) => f.path.endsWith(".css"))
  if (!cssFile) throw new Error("esbuild produced no CSS output for globals.css")
  return cssFile.contents
}

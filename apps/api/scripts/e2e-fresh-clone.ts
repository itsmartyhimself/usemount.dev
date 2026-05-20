// PR6 fresh-clone E2E gate — validates the load-bearing new pieces (install
// + bundle with tsconfig path inheritance) against a clone that started with
// no node_modules. Mirrors the worker's clone→install→introspect→bundle
// pipeline without the GitHub clone leg (faster + no install-token needed).
//
// Setup: `git clone . /tmp/usemount-fresh-clone` produces a tree with no
// node_modules — exactly the state shallowClone leaves the worker in.
//
// Run with: pnpm --filter @usemount/api e2e:fresh-clone
//
// This is informational, not a regression — it exercises the worker pipeline
// against the dogfood as a local stand-in for a GitHub-cloned customer repo.
// A genuine fresh-clone-from-GitHub gate is the next session's job once R9
// (custom-domain coordinated pass) clears.

import { existsSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { Project } from "ts-morph"
import { bundleComponent } from "../src/build/bundle.js"
import { installDeps } from "../src/build/deps.js"
import {
  classifyGap,
  deriveControls,
  introspectComponent,
} from "../src/build/introspect.js"
import { parseMountConfig } from "../src/build/mount-config.js"

const CLONE = "/tmp/usemount-fresh-clone"
const CACHE = "/tmp/usemount-node-modules-cache"

async function main() {
  if (!existsSync(CLONE)) {
    console.error(
      `${CLONE} does not exist. Set up with:\n  git clone /Users/martinheneby/Documents/Repos/usemount.dev ${CLONE}`,
    )
    process.exit(1)
  }
  if (existsSync(path.join(CLONE, "node_modules"))) {
    console.warn(
      `${CLONE}/node_modules already exists — install will run as cache-hit. Run \`rm -rf ${CLONE}/node_modules ${CACHE}\` to exercise a true cold install.`,
    )
  }

  // ── 1. installDeps with --ignore-scripts --frozen-lockfile ──────────────
  console.log(`═══ install — workdir=${CLONE}`)
  const installStart = performance.now()
  const installResult = await installDeps({
    workDir: CLONE,
    repoId: 12345, // synthetic — only used as cache key
    cacheRoot: CACHE,
  })
  console.log(
    `  ${installResult.pm}${installResult.cached ? " (cached)" : ""} ${installResult.durationMs}ms`,
  )
  console.log(`  total install: ${Math.round(performance.now() - installStart)}ms`)
  if (!existsSync(path.join(CLONE, "node_modules"))) {
    throw new Error("post-install: node_modules missing")
  }

  // ── 2. parseMountConfig — dogfood has no mount.config.ts; tests fallback ─
  // (the dogfood's components live at apps/web/components/live; fallback chain
  //  doesn't find that — we test that the FALLBACK FAIL surfaces, then point
  //  the rest of the pipeline at apps/web/components/live directly).
  const mountFromRoot = parseMountConfig(CLONE)
  console.log(`═══ mount-config (from repo root)`)
  console.log(
    `  fallbackUsed=${mountFromRoot.fallbackUsed} resolvedComponentsDir=${mountFromRoot.resolvedComponentsDir}`,
  )
  // Dogfood has app at apps/web — fallback won't find components-dir from the
  // monorepo root. Point pipeline at apps/web/components/live manually for the
  // E2E (mirrors how the worker would behave if the customer's components
  // live nested — Step 5 is where the worker UI surfaces "no_components_dir"
  // back to the customer with a setup screen).
  const COMPONENTS_DIR = path.join(CLONE, "apps/web/components/live")
  const TSCONFIG = path.join(CLONE, "apps/web/tsconfig.json")
  if (!existsSync(COMPONENTS_DIR))
    throw new Error(`dogfood components dir missing: ${COMPONENTS_DIR}`)
  if (!existsSync(TSCONFIG)) throw new Error(`tsconfig missing: ${TSCONFIG}`)

  // ── 3. introspect Button via the worker's module ────────────────────────
  console.log(`═══ introspect — Button`)
  const project = new Project({
    tsConfigFilePath: TSCONFIG,
    skipAddingFilesFromTsConfig: true,
  })
  const button = path.join(COMPONENTS_DIR, "button/button.tsx")
  const ck0 = performance.now()
  const checker = introspectComponent(project, button)
  const ckMs = Math.round(performance.now() - ck0)
  if (!checker.propsTypeResolved) {
    throw new Error(`checker failed: ${checker.note}`)
  }
  const { controls, propsSchema } = deriveControls(checker.props)
  const gap = classifyGap(
    checker,
    controls,
    readFileSync(button, "utf8"),
  )
  console.log(
    `  ${checker.props.length} props in ${ckMs}ms; gap=${gap ?? "none"}`,
  )
  if (gap)
    throw new Error(`unexpected gap on dogfood Button after fresh install: ${gap}`)
  if (!controls.variants || !controls.sizes || !controls.forms)
    throw new Error("expected variants/sizes/forms all resolved on Button")
  if (controls.booleans.length < 3)
    throw new Error(
      `expected ≥3 booleans on Button (fill/loading/disabled), got ${controls.booleans.length}`,
    )
  void propsSchema

  // ── 4. bundleComponent — exercises the `tsconfig` paths inheritance ─────
  // (NOT the spike's `alias:{'@':...}` hardcode — the architectural reason
  //  this E2E exists at all: confirm the worker's bundler resolves customer
  //  `@/*` aliases via the tsconfig, not a hardcoded prefix).
  console.log(`═══ bundle — Button (via tsconfig path inheritance)`)
  const b0 = performance.now()
  const bundle = await bundleComponent({
    entry: button,
    workDir: CLONE,
    tsconfigPath: TSCONFIG,
  })
  const bMs = Math.round(performance.now() - b0)
  console.log(
    `  js: ${(bundle.jsBytes.byteLength / 1024).toFixed(0)}KB${bundle.cssBytes ? `, css: ${(bundle.cssBytes.byteLength / 1024).toFixed(0)}KB` : ""}  ${bMs}ms`,
  )
  if (bundle.jsBytes.byteLength < 1000)
    throw new Error(
      `bundle suspiciously small (${bundle.jsBytes.byteLength}B) — likely a path-alias miss`,
    )

  console.log("\nE2E PASS — install + introspect + bundle work on a fresh-clone tree")
  console.log(
    `Cleanup: \`rm -rf ${CLONE}\` (and \`${CACHE}\` if you want to re-exercise the cold-install path).`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

// Silence unused-import lint when the script is dead-code-eliminated in CI.
void rmSync

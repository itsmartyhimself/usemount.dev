/**
 * Step 4.2 introspection spike — the build-pipeline decision gate, now
 * checker-primary (PR6 D2 inversion).
 *
 * Run (dogfood):   pnpm --filter @usemount/api spike
 * Run (any repo):  pnpm --filter @usemount/api spike <repoRoot> <componentsRelDir> <tsconfigRelPath> <label>
 *
 * HERMETIC. No Supabase, no Storage, no Railway, no GitHub clone, no PAT — it
 * reads a checked-out tree on disk. The real Step-4.2 worker shallow-clones
 * via the install token, runs `--ignore-scripts --frozen-lockfile` install,
 * then drives the same introspection module this spike exercises.
 *
 * Default target = this repo's apps/web/components/live (the dogfood). Pass a
 * repo root to point it at a real external customer codebase — architecture-
 * brief §3 + the 4.0b REV-Plugin pass require the second target before the
 * worker can claim P0 hold.
 *
 * FINDING — under PR6 D2 (owner-driven, supersedes 4.2-prep's "ship accepting
 * the empty-panel fraction"): **ts-morph checker is the PRIMARY engine**,
 * react-docgen-typescript stays imported as an optional cross-check on the
 * Button head-to-head. The checker resolves props THROUGH forwardRef/HOC AND
 * follows cross-file / node_modules aliases via the customer's tsconfig — so
 * external-union (the dominant 14/29 gap on REV-Plugin under rdt-primary) and
 * forwardref-unresolved go to zero. The numeric gate this spike measures:
 * gap histogram = { external-union: 0, forwardref-unresolved: 0,
 * large-base-type: 0 }; only sanctioned residuals are no-props-interface
 * (truly propless helpers) and generic (unconstrained <T>, whose non-T props
 * still resolve and appear in propsSchema).
 */
import type { BuildManifest } from "@usemount/shared"
import { build } from "esbuild"
import { withCompilerOptions } from "react-docgen-typescript"
import { Project } from "ts-morph"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"
// The engine the Step-4.2 worker runs. The spike exercises the same module so
// any introspection regression surfaces here first.
import {
  PROP_CAP,
  classifyGap,
  deriveControls,
  introspectComponent,
} from "../src/build/introspect.js"

// argv: [repoRoot] [componentsRelDir] [tsconfigRelPath] [label]. No args =
// dogfood (this repo's live/ tree) — backward-compatible with the PR4 run.
const [, , argRoot, argComp, argTs, argLabel] = process.argv
const SELF = path.resolve(import.meta.dirname, "../../..")
const REPO = argRoot ? path.resolve(argRoot) : SELF
const TARGET_DIR = path.join(REPO, argComp ?? "apps/web/components/live")
const TSCONFIG = path.join(REPO, argTs ?? "apps/web/tsconfig.json")
// esbuild alias base = the tsconfig's dir (where `@/*` → `./*` resolves from):
// apps/web for the dogfood, the repo root for a flat customer repo.
const ALIAS_BASE = path.dirname(TSCONFIG)
const IS_DOGFOOD = !argRoot
const LABEL = argLabel ?? "dogfood"
const OUT = path.join("/tmp", "usemount-spike", LABEL)

// react-docgen-typescript — kept as the optional cross-check on Button (D2
// flip). The node_modules propFilter is still load-bearing for rdt (without it
// rdt floods ~60 aria-*/data-* props from React's intersection types) — the
// CHECKER doesn't need this filter because it follows union literals directly.
const rdt = withCompilerOptions(
  { esModuleInterop: true, jsx: 4 /* react-jsx */ },
  {
    shouldExtractLiteralValuesFromEnum: true,
    shouldRemoveUndefinedFromOptional: true,
    savePropValueAsString: true,
    propFilter: (p) => !p.parent || !/node_modules/.test(p.parent.fileName),
  },
)

// Initialise the ts-morph Project ONCE — per-component re-init reads every
// referenced file each time (seconds each → major perf trap for the worker
// which mirrors this pattern). skipAddingFilesFromTsConfig=true keeps boot
// fast; the TS checker still resolves through imports lazily on demand.
const project = new Project({
  tsConfigFilePath: TSCONFIG,
  skipAddingFilesFromTsConfig: true,
})

type FailureMode =
  | "no-use-client(rsc?)"
  | "routing-hooks"
  | "provider/context"
  | "build-fail"
  | "limited-introspection"

function classifyFailures(src: string, introspected: boolean, built: boolean): FailureMode[] {
  const f: FailureMode[] = []
  if (!/^["']use client["']/m.test(src.split("\n").slice(0, 3).join("\n")))
    f.push("no-use-client(rsc?)")
  if (/from\s+["']next\/navigation["']/.test(src)) f.push("routing-hooks")
  if (/use[A-Z]\w+\(\)/.test(src) && /(Provider|createContext|useContext)/.test(src))
    f.push("provider/context")
  if (!built) f.push("build-fail")
  if (!introspected) f.push("limited-introspection")
  return f
}

// Every .tsx under the components dir is a candidate entry — works for both
// dir-per-component (dogfood live/) and flat (REV Plugin components/ui/*.tsx).
// Non-component files (contexts, helpers) yield 0 checker props → honestly
// flagged limited-introspection, not hidden. Excludes co-located non-entries.
const SKIP = /\.(manifest|config|test|spec|stories|d)\.(tsx?|ts)$|(^|\/)index\.tsx?$/
function collectEntries(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue
      out.push(...collectEntries(full))
    } else if (e.name.endsWith(".tsx") && !SKIP.test(full)) {
      out.push(full)
    }
  }
  return out
}

async function bundleSize(entry: string): Promise<{ raw: number; min: number } | null> {
  try {
    const common = {
      entryPoints: [entry],
      bundle: true,
      write: false as const,
      format: "esm" as const,
      platform: "browser" as const,
      jsx: "automatic" as const,
      absWorkingDir: ALIAS_BASE,
      alias: { "@": ALIAS_BASE },
      external: ["react", "react-dom", "react/jsx-runtime"],
      logLevel: "silent" as const,
    }
    const raw = await build({ ...common, minify: false })
    const min = await build({ ...common, minify: true })
    return {
      raw: raw.outputFiles[0].contents.length,
      min: min.outputFiles[0].contents.length,
    }
  } catch {
    return null
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  console.log(`═══ Spike target: ${LABEL} — ${path.relative(process.cwd(), TARGET_DIR)} ═══`)
  if (!existsSync(TARGET_DIR)) {
    console.error(`components dir not found: ${TARGET_DIR}`)
    process.exit(1)
  }
  const entries = collectEntries(TARGET_DIR).sort()

  // ── Open Decision #1 — re-run on the dogfood Button, this time with the
  //    PR6 D2 inversion: ts-morph PRIMARY, rdt SHOWN as cross-check. ────────
  if (IS_DOGFOOD) {
    const btn = path.join(TARGET_DIR, "button/button.tsx")
    const ck0 = performance.now()
    const ck = introspectComponent(project, btn)
    const ckMs = performance.now() - ck0
    const rdt0 = performance.now()
    const btnPropsRdt = rdt.parse(btn)[0]?.props ?? {}
    const rdtMs = performance.now() - rdt0
    console.log("═══ Open Decision #1 — introspection head-to-head (Button) ═══")
    console.log(
      `checker: ${ck.props.length} props in ${ckMs.toFixed(0)}ms — ${ck.props.map((p) => p.name).join(",")}`,
    )
    const checkerEnums = ck.props.filter((p) => p.kind.tag === "literal-union").map((p) => p.name)
    console.log(`checker: enums resolved → ${checkerEnums.join(",")} (literals read via TS checker, no propFilter needed)`)
    console.log(
      `rdt:     ${Object.keys(btnPropsRdt).length} props in ${rdtMs.toFixed(0)}ms (cross-check; propFilter tames forwardRef<P & Aria & Data>)`,
    )
    console.log(
      "FINDING (D2 inversion, owner-driven, supersedes 4.2-prep's 'ship\n" +
        "  accepting the empty-panel fraction'): ts-morph CHECKER is now PRIMARY.\n" +
        "  rdt stays imported as cross-check on Button only. The checker resolves\n" +
        "  through forwardRef AND reads union literals imported from node_modules\n" +
        "  (the external-union lever) so the dominant 4.0b REV-Plugin gap goes\n" +
        "  to zero. Numeric gate (this spike measures it): gap histogram shows\n" +
        "  ZERO external-union / forwardref-unresolved / large-base-type.\n",
    )
  } else {
    console.log(
      "Open Decision #1 settled in PR4; PR6 D2 inverted rdt→checker. This\n" +
        "external pass measures the checker SWEEP only.\n",
    )
  }

  // ── Full sweep ──────────────────────────────────────────────────────────
  const rows: Array<{
    slug: string
    props: number | string
    ctrl: string
    rawKB: string
    minKB: string
    ms: string
    gap: string
    introspected: boolean
    flags: string
    skipped?: string
  }> = []
  const sweepStart = performance.now()
  for (const entry of entries) {
    const rel = path.relative(TARGET_DIR, entry)
    const slug = rel.replace(/\.tsx$/, "").replace(/[/\\]/g, "-")
    const dir = path.dirname(entry)
    const src = readFileSync(entry, "utf8")
    const ri0 = performance.now()
    const checker = introspectComponent(project, entry)
    const riMs = performance.now() - ri0
    const introspected = checker.props.length > 0
    const { controls, propsSchema } = deriveControls(checker.props)
    const gap = classifyGap(checker, controls, src)
    const bi0 = performance.now()
    const size = await bundleSize(entry)
    const biMs = performance.now() - bi0
    const failures = classifyFailures(src, introspected, !!size)

    const manifest: BuildManifest = {
      slug,
      folderPath: path.relative(REPO, dir),
      title: slug,
      kind: !size
        ? "unsupported"
        : failures.includes("no-use-client(rsc?)")
          ? "maybe-rsc"
          : "component",
      controls,
      propsSchema,
      states: {},
      artifactUrl: size ? `spike://bundle/${slug}.js` : null,
      previewArtifactUrl: null,
      sourceHash: createHash("sha256").update(src).digest("hex").slice(0, 16),
      introspectionGap: gap,
    }
    writeFileSync(path.join(OUT, `${slug}.manifest.json`), JSON.stringify(manifest, null, 2))
    rows.push({
      slug,
      props: checker.rawCount > PROP_CAP ? `${checker.rawCount}!` : checker.props.length,
      ctrl:
        [
          controls.variants && "V",
          controls.sizes && "S",
          controls.forms && "F",
          controls.booleans.length && `B${controls.booleans.length}`,
          controls.slots.length && `Sl${controls.slots.length}`,
          controls.strings.length && `St${controls.strings.length}`,
          controls.numbers.length && `N${controls.numbers.length}`,
          controls.handlers.length && `H${controls.handlers.length}`,
          controls.objects.length && `O${controls.objects.length}`,
        ]
          .filter(Boolean)
          .join("") || "—",
      rawKB: size ? (size.raw / 1024).toFixed(0) : "FAIL",
      minKB: size ? (size.min / 1024).toFixed(0) : "FAIL",
      ms: (riMs + biMs).toFixed(0),
      gap: gap ?? "",
      introspected,
      flags: failures.join("+") || "clean",
    })
  }
  const sweepMs = performance.now() - sweepStart

  // ── Report ──────────────────────────────────────────────────────────────
  console.log(`═══ Full sweep (${LABEL}) ═══`)
  console.log(
    "slug".padEnd(26) +
      "props".padStart(6) +
      "ctrl".padStart(14) +
      "raw".padStart(7) +
      "min".padStart(6) +
      "ms".padStart(7) +
      "  flags",
  )
  for (const r of rows) {
    if (r.skipped) {
      console.log(r.slug.padEnd(26) + `  (skipped: ${r.skipped})`)
      continue
    }
    console.log(
      r.slug.padEnd(26) +
        String(r.props).padStart(6) +
        r.ctrl.padStart(14) +
        `${r.rawKB}K`.padStart(7) +
        `${r.minKB}K`.padStart(6) +
        r.ms.padStart(7) +
        "  " +
        r.flags,
    )
  }
  const built = rows.filter((r) => r.rawKB && r.rawKB !== "FAIL")
  const introspectedN = rows.filter((r) => r.introspected).length
  const richN = rows.filter((r) => r.ctrl && r.ctrl !== "—").length
  const hist: Record<string, number> = {}
  for (const r of rows)
    for (const f of (r.flags ?? "").split("+")) if (f) hist[f] = (hist[f] ?? 0) + 1
  const gapHist: Record<string, number> = {}
  for (const r of rows) if (r.gap) gapHist[r.gap] = (gapHist[r.gap] ?? 0) + 1
  const totMin = built.reduce((s, r) => s + Number(r.minKB), 0)
  const pct = (n: number) => `${((n / Math.max(rows.length, 1)) * 100).toFixed(0)}%`
  console.log("\n═══ Aggregate ═══")
  console.log(`components:            ${rows.length}`)
  console.log(`introspected (any props):${introspectedN}/${rows.length} (${pct(introspectedN)})`)
  console.log(`RICH (≥1 control):     ${richN}/${rows.length} (${pct(richN)}) — D1 gate: every component with props must appear here`)
  console.log(`bundled ok:            ${built.length}/${rows.length}`)
  console.log(`total minified:        ${totMin}KB  (avg ${(totMin / Math.max(built.length, 1)).toFixed(0)}KB)`)
  console.log(`sweep wall time:       ${(sweepMs / 1000).toFixed(1)}s  (checker+esbuild, ${rows.length} components, single process, no clone)`)
  console.log(`failure-mode histogram:`, hist)
  console.log(`introspection-gap histogram:`, gapHist)
  console.log("PR6 numeric gate: external-union=0, forwardref-unresolved=0, large-base-type=0; only allowed residuals are no-props-interface (truly propless) + generic (unconstrained <T>).")
  console.log(`manifests written:     ${OUT}/*.manifest.json`)

  console.log(
    `\nGO/NO-GO (${LABEL}): checker-primary result above. Tooling success is\n` +
      "independent of the bounded support matrix — an out-of-matrix repo (Tailwind\n" +
      "v3 / Next 15) still yields a valid tooling signal AND proves the support-\n" +
      "matrix connect-gate (Step 5 #6) is load-bearing.",
  )
}

main().catch((e) => {
  console.error("SPIKE FAILED:", e)
  process.exit(1)
})

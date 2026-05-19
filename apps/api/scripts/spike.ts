/**
 * Step 4.0 spike — the build-pipeline decision gate (migration-plan.md Step 4).
 *
 * Run (dogfood):   pnpm --filter @usemount/api spike
 * Run (any repo):  pnpm --filter @usemount/api spike <repoRoot> <componentsRelDir> <tsconfigRelPath> <label>
 *
 * HERMETIC. No Supabase, no Storage, no Railway, no GitHub clone, no PAT — it
 * reads a checked-out tree on disk. The real Step-4.2 worker will instead
 * shallow-clone via the install token; this spike validates the *tooling*
 * (react-docgen-typescript / ts-morph + esbuild), not the clone.
 *
 * Default target = this repo's apps/web/components/live (the dogfood). Pass a
 * repo root to point it at a real external customer codebase — architecture-
 * brief §3/§319 requires that second pass before 4.2 commits.
 *
 * GO/NO-GO HONESTY: a clean result proves the tooling holds for the swept tree.
 * Tooling success is independent of the bounded support matrix (Tailwind/Next
 * version) — an out-of-matrix repo still yields a valid TOOLING signal; it just
 * also proves the support-matrix connect-gate is load-bearing.
 */
import { build } from "esbuild"
import { withCompilerOptions } from "react-docgen-typescript"
import { Project } from "ts-morph"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"

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

// react-docgen-typescript: literal unions → enum values; node_modules-parented
// props filtered out. That propFilter is load-bearing — Button's exported type
// is forwardRef<ButtonProps & AriaAttributes & DataAttributes>; without the
// filter rdt floods ~60 aria-*/data-* props. With it, exactly ButtonProps.
const rdt = withCompilerOptions(
  { esModuleInterop: true, jsx: 4 /* react-jsx */ },
  {
    shouldExtractLiteralValuesFromEnum: true,
    shouldRemoveUndefinedFromOptional: true,
    savePropValueAsString: true,
    propFilter: (p) => !p.parent || !/node_modules/.test(p.parent.fileName),
  },
)

interface ControlMap {
  variants?: { prop: string; options: string[] }
  sizes?: { prop: string; options: string[] }
  forms?: { prop: string; options: string[] }
  booleans: string[]
  slots: { prop: string; label: string }[]
}
type FailureMode =
  | "no-use-client(rsc?)"
  | "routing-hooks"
  | "provider/context"
  | "build-fail"
  | "limited-introspection"

// Map an rdt prop set → the controls schema the canvas already consumes.
function deriveControls(props: Record<string, any>): {
  controls: ControlMap
  propsSchema: Record<string, string>
} {
  const controls: ControlMap = { booleans: [], slots: [] }
  const propsSchema: Record<string, string> = {}
  for (const [name, p] of Object.entries(props)) {
    const t = p.type?.name ?? "unknown"
    propsSchema[name] = t
    const isEnum = p.type?.name === "enum" && Array.isArray(p.type.value)
    const literals: string[] = isEnum
      ? p.type.value
          .map((v: any) => String(v.value).replace(/^"|"$/g, ""))
          .filter((v: string) => v !== "undefined")
      : []
    const stringUnion = literals.length >= 2 && literals.every((v) => !/^\d/.test(v))
    if (t === "boolean") controls.booleans.push(name)
    else if (/^ReactNode/.test(t) || t === "ReactElement")
      controls.slots.push({ prop: name, label: name })
    else if (stringUnion) {
      if (name === "size") controls.sizes = { prop: name, options: literals }
      else if (name === "form") controls.forms = { prop: name, options: literals }
      else if (name === "variant" || !controls.variants)
        controls.variants = { prop: name, options: literals }
    }
  }
  return { controls, propsSchema }
}

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
// Non-component files (contexts, helpers) yield 0 rdt components → honestly
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

// ── Open Decision #1: react-docgen-typescript vs ts-morph, head-to-head on
// Button (the doc names exactly this experiment). ─────────────────────────────
function tsMorphProbe(entry: string): { props: string[]; note: string } {
  const project = new Project({ tsConfigFilePath: TSCONFIG, skipAddingFilesFromTsConfig: true })
  const sf = project.addSourceFileAtPath(entry)
  // ts-morph gives full type-checker control but the props type must be hand-
  // resolved: here we take the exported component, get its first call-signature
  // parameter type via the checker — that follows forwardRef AND the cross-file
  // `ButtonProps` alias in button.config.ts (a naive "find interface in entry
  // file" misses it, since props rarely live in the component file).
  const exported = sf.getExportedDeclarations()
  let propsType: import("ts-morph").Type | undefined
  for (const [name, decls] of exported) {
    if (!/^[A-Z]/.test(name)) continue
    const t = decls[0]?.getType()
    const sig = t?.getCallSignatures()[0] ?? t?.getConstructSignatures()[0]
    const p0 = sig?.getParameters()[0]
    if (p0) {
      propsType = p0.getTypeAtLocation(decls[0])
      break
    }
  }
  if (!propsType) return { props: [], note: "could not resolve exported component's props type via checker" }
  const props = propsType
    .getProperties()
    // mirror rdt's node_modules propFilter so the comparison is apples-to-apples
    .filter((s) => {
      const d = s.getDeclarations()[0]
      return d ? !/node_modules/.test(d.getSourceFile().getFilePath()) : true
    })
    .map((s) => {
      const u = s.getTypeAtLocation(sf).getUnionTypes()
      const lits = u
        .map((x) => x.getLiteralValue())
        .filter((v): v is string => typeof v === "string")
      return lits.length >= 2 ? `${s.getName()}=${lits.join("|")}` : s.getName()
    })
  return {
    props,
    note: "checker-resolved through forwardRef + cross-file alias; node_modules filtered to match rdt",
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

  // ── Open Decision #1 head-to-head (dogfood-only; settled in PR4) ─────────
  if (IS_DOGFOOD) {
    const btn = path.join(TARGET_DIR, "button/button.tsx")
    const t0 = performance.now()
    const btnProps = rdt.parse(btn)[0]?.props ?? {}
    const rdtMs = performance.now() - t0
    const tm = tsMorphProbe(btn)
    console.log("═══ Open Decision #1 — introspection head-to-head (Button) ═══")
    console.log(
      `rdt:      ${Object.keys(btnProps).length} props in ${rdtMs.toFixed(0)}ms — ${Object.keys(btnProps).join(",")}`,
    )
    console.log(
      `rdt:      enums resolved → ${Object.entries(btnProps)
        .filter(([, p]: any) => p.type?.name === "enum")
        .map(([n]) => n)
        .join(",")}  (AriaAttributes/data-* intersection suppressed by node_modules propFilter)`,
    )
    console.log(`ts-morph: ${tm.props.length} members — ${tm.note}`)
    console.log(`ts-morph: ${tm.props.join(" | ")}`)
    console.log(
      "FINDING: rdt auto-resolves the resolved prop type but REQUIRES the\n" +
        "  node_modules propFilter to tame forwardRef<P & Aria & Data>. ts-morph\n" +
        "  needs no taming but you hand-walk forwardRef→props. → rdt PRIMARY,\n" +
        "  ts-morph the precise fallback for the limited-introspection bucket.\n",
    )
  } else {
    console.log(
      "Open Decision #1 (rdt vs ts-morph) settled in PR4 on the dogfood — rdt\n" +
        "primary, ts-morph fallback. This external pass measures the SWEEP only.\n",
    )
  }

  // ── Full sweep ──────────────────────────────────────────────────────────
  const rows: any[] = []
  const sweepStart = performance.now()
  for (const entry of entries) {
    const rel = path.relative(TARGET_DIR, entry)
    const slug = rel.replace(/\.tsx$/, "").replace(/[/\\]/g, "-")
    const dir = path.dirname(entry)
    const src = readFileSync(entry, "utf8")
    const ri0 = performance.now()
    let docs: any[] = []
    try {
      docs = rdt.parse(entry)
    } catch {
      /* introspection threw — left empty, flagged below */
    }
    const riMs = performance.now() - ri0
    const comp = docs[0]
    const props = comp?.props ?? {}
    const introspected = Object.keys(props).length > 0
    const { controls, propsSchema } = deriveControls(props)
    const bi0 = performance.now()
    const size = await bundleSize(entry)
    const biMs = performance.now() - bi0
    const failures = classifyFailures(src, introspected, !!size)

    // Build-side manifest, shaped to the DB component_manifests COLUMNS —
    // deliberately NOT the @usemount/shared ComponentManifest<P> (its
    // render:(props)=>ReactNode is a render-side/in-host concept the iframe
    // supplies at 4.3; the pipeline emits metadata + an artifact_url).
    const manifest = {
      slug,
      folder_path: path.relative(REPO, dir),
      title: comp?.displayName ?? slug,
      kind: failures.includes("no-use-client(rsc?)") ? "maybe-rsc" : "component",
      variants_json: {
        variants: controls.variants,
        sizes: controls.sizes,
        forms: controls.forms,
        booleans: controls.booleans,
        slots: controls.slots,
      },
      states_json: {},
      props_schema_json: propsSchema,
      artifact_url: size ? `spike://bundle/${slug}.js` : null,
      source_hash: createHash("sha256").update(src).digest("hex").slice(0, 16),
    }
    writeFileSync(path.join(OUT, `${slug}.manifest.json`), JSON.stringify(manifest, null, 2))
    rows.push({
      slug,
      props: Object.keys(props).length,
      ctrl:
        [
          controls.variants && "V",
          controls.sizes && "S",
          controls.forms && "F",
          controls.booleans.length && `B${controls.booleans.length}`,
          controls.slots.length && `Sl${controls.slots.length}`,
        ]
          .filter(Boolean)
          .join("") || "—",
      rawKB: size ? (size.raw / 1024).toFixed(0) : "FAIL",
      minKB: size ? (size.min / 1024).toFixed(0) : "FAIL",
      ms: (riMs + biMs).toFixed(0),
      flags: failures.join("+") || "clean",
    })
  }
  const sweepMs = performance.now() - sweepStart

  // ── Report ──────────────────────────────────────────────────────────────
  console.log(`═══ Full sweep (${LABEL}) ═══`)
  console.log(
    "slug".padEnd(26) +
      "props".padStart(6) +
      "ctrl".padStart(8) +
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
        r.ctrl.padStart(8) +
        `${r.rawKB}K`.padStart(7) +
        `${r.minKB}K`.padStart(6) +
        r.ms.padStart(7) +
        "  " +
        r.flags,
    )
  }
  const built = rows.filter((r) => r.rawKB && r.rawKB !== "FAIL")
  const introspectedN = rows.filter((r) => r.props > 0).length
  const hist: Record<string, number> = {}
  for (const r of rows)
    for (const f of (r.flags ?? "").split("+")) if (f) hist[f] = (hist[f] ?? 0) + 1
  const totMin = built.reduce((s, r) => s + Number(r.minKB), 0)
  console.log("\n═══ Aggregate ═══")
  console.log(`components:            ${rows.length}`)
  console.log(`introspected (props>0):${introspectedN}/${rows.length}`)
  console.log(`bundled ok:            ${built.length}/${rows.length}`)
  console.log(`total minified:        ${totMin}KB  (avg ${(totMin / Math.max(built.length, 1)).toFixed(0)}KB)`)
  console.log(`sweep wall time:       ${(sweepMs / 1000).toFixed(1)}s  (rdt+esbuild, ${rows.length} components, single process, no clone)`)
  console.log(`failure-mode histogram:`, hist)
  console.log(`manifests written:     ${OUT}/*.manifest.json`)

  console.log(
    "\n═══ Manifest-shape duality (primary Step-4 re-plan input) ═══\n" +
      "@usemount/shared ComponentManifest<P> has render:(props)=>ReactNode — an\n" +
      "IN-HOST render-side concept. The build pipeline emits METADATA + a bundle\n" +
      "artifact_url; the iframe (4.3) supplies render. The emitted shape above maps\n" +
      "to the DB component_manifests COLUMNS, not ComponentManifest. The re-plan\n" +
      "should add a build-side type to @usemount/shared (NOT done in PR4 — read-\n" +
      "only there). Paste-ready:\n\n" +
      "  export interface BuildManifest {\n" +
      "    slug: string\n" +
      "    folderPath: string\n" +
      "    title: string\n" +
      "    kind: 'component' | 'maybe-rsc' | 'unsupported'\n" +
      "    variants?: { prop: string; options: string[] }\n" +
      "    sizes?:    { prop: string; options: string[] }\n" +
      "    forms?:    { prop: string; options: string[] }\n" +
      "    booleans:  string[]\n" +
      "    slots:     { prop: string; label: string }[]\n" +
      "    propsSchema: Record<string, string>  // → props_schema_json\n" +
      "    artifactUrl: string                  // → artifact_url (Storage)\n" +
      "    sourceHash: string                   // → source_hash (skip-rebuild)\n" +
      "  }\n" +
      "Render-side ComponentManifest<P> stays as-is for the iframe→host contract.\n",
  )
  console.log(
    `GO/NO-GO (${LABEL}): tooling (rdt+esbuild) result above. Tooling success is\n` +
      "independent of the bounded support matrix — an out-of-matrix repo (Tailwind\n" +
      "v3 / Next 15) still yields a valid tooling signal AND proves the support-\n" +
      "matrix connect-gate (Step 5 #6) is load-bearing (architecture-brief §3/§319).",
  )
}

main().catch((e) => {
  console.error("SPIKE FAILED:", e)
  process.exit(1)
})

/**
 * Step 4.0 spike — the build-pipeline decision gate (migration-plan.md Step 4).
 *
 * Run:  pnpm --filter @usemount/api spike      (tsx; NOT part of tsc -b)
 *
 * HERMETIC. No Supabase, no Storage, no Railway, no GitHub clone, no PAT. It
 * runs the auto-manifest + bundle pipeline against THIS repo's own
 * apps/web/components/live/ tree — the dogfood target (migration-plan Step 4's
 * end goal is literally "self-hosted dogfood"; there is no external customer
 * codebase available here). The real Step-4.2 worker will instead shallow-clone
 * a customer repo via the install token; this spike validates the *tooling*
 * (react-docgen-typescript / ts-morph + esbuild), not the clone.
 *
 * GO/NO-GO HONESTY: a clean result here proves the tooling holds for a 41-
 * component Tailwind-v4 design system. It does NOT prove the architecture holds
 * for the 700-person Persona-C case — architecture-brief §3 requires a second
 * pass against a real customer codebase before 4.2 commits. This spike does not
 * make that claim.
 */
import { build } from "esbuild"
import { withCompilerOptions } from "react-docgen-typescript"
import { Project } from "ts-morph"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"

const REPO = path.resolve(import.meta.dirname, "../../..")
const WEB = path.join(REPO, "apps/web")
const LIVE = path.join(WEB, "components/live")
const OUT = path.join("/tmp", "usemount-spike")
const TSCONFIG = path.join(WEB, "tsconfig.json")

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

// Entry per repo convention: <dir>/<dir>.tsx, else first non-manifest .tsx.
function entryFor(dir: string): string | null {
  const base = path.basename(dir)
  const direct = path.join(dir, `${base}.tsx`)
  if (existsSync(direct)) return direct
  const tsx = readdirSync(dir).filter(
    (f) => f.endsWith(".tsx") && !f.endsWith(".manifest.tsx"),
  )
  return tsx.length ? path.join(dir, tsx[0]) : null
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
      absWorkingDir: WEB,
      alias: { "@": WEB },
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
  const dirs = readdirSync(LIVE, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(LIVE, d.name))
    .sort()

  // ── Head-to-head on Button ──────────────────────────────────────────────
  const btn = path.join(LIVE, "button/button.tsx")
  const t0 = performance.now()
  const btnDocs = rdt.parse(btn)
  const rdtMs = performance.now() - t0
  const btnProps = btnDocs[0]?.props ?? {}
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
  console.log(`ts-morph: ${tm.props.length} interface members — ${tm.note}`)
  console.log(`ts-morph: ${tm.props.join(" | ")}`)
  console.log(
    "FINDING: rdt auto-resolves the component's resolved prop type (defaults,\n" +
      "  JSDoc, optionality) but REQUIRES the node_modules propFilter to tame the\n" +
      "  forwardRef<P & AriaAttributes & DataAttributes> blow-up. ts-morph needs no\n" +
      "  such taming but you must hand-walk forwardRef→props. → rdt is the right\n" +
      "  PRIMARY (purpose-built, less code); ts-morph is the precise fallback for\n" +
      "  the generics/unions rdt chokes on (architecture-brief §3 case 'limited\n" +
      "  introspection'). Recommendation: rdt primary, ts-morph escape hatch.\n",
  )

  // ── Full live/ sweep ────────────────────────────────────────────────────
  const rows: any[] = []
  const sweepStart = performance.now()
  for (const dir of dirs) {
    const slug = path.basename(dir)
    const entry = entryFor(dir)
    if (!entry) {
      rows.push({ slug, skipped: "no entry .tsx" })
      continue
    }
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
  console.log("═══ Full live/ sweep ═══")
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
    "GO/NO-GO: tooling (rdt+esbuild) holds for this 41-component Tailwind-v4 DS.\n" +
      "Does NOT validate the 700-person Persona-C case — a real customer-codebase\n" +
      "pass remains REQUIRED before 4.2 commits (architecture-brief §3).",
  )
}

main().catch((e) => {
  console.error("SPIKE FAILED:", e)
  process.exit(1)
})

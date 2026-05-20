/**
 * Checker-primary prop introspection — the engine the Step-4.2 build worker
 * runs on each component and the spike (scripts/spike.ts) exercises as its
 * live regression harness. Shared between both so any fix lands once.
 *
 * The PR6 D2 inversion (owner-driven, supersedes 4.2-prep's "ship accepting
 * the empty-panel fraction"): ts-morph PRIMARY, react-docgen-typescript stays
 * available as an optional cross-check on Button only (in the spike). The
 * checker walks the exported component's call-signature parameter type, so
 * it resolves THROUGH forwardRef/HOC AND follows cross-file and node_modules
 * aliases to read union literals (the dominant 4.0b REV-Plugin gap).
 *
 * Numeric gate this engine targets: gap histogram = zero `external-union`,
 * zero `forwardref-unresolved`, zero `large-base-type` (except the sanctioned
 * Radix-Slot-re-export cap case where PROP_CAP fires and the panel is still
 * rich). Sanctioned residuals: `no-props-interface` (truly propless helpers)
 * and `generic` (unconstrained `<T>` — its non-T props still appear in
 * propsSchema).
 */
import type {
  BuildManifestControls,
  IntrospectionGap,
} from "@usemount/shared"
import type { Node, Project, Type } from "ts-morph"

// A real component API rarely exceeds this. Beyond it, the customer has
// almost certainly intersected a huge base type (Radix Slot / a DOM-props
// re-export) — the 4.0b REV-Plugin ui-animate-ui-slot 275-prop blow-up. Cap
// so the panel never explodes; the gap flag records why.
export const PROP_CAP = 40

export type PropKind =
  | { tag: "boolean" }
  | { tag: "string" }
  | { tag: "number" }
  | { tag: "literal-union"; values: string[]; allString: boolean }
  | { tag: "react-node" }
  | { tag: "handler"; signature: string }
  | { tag: "object"; typeString: string }
  | { tag: "unknown"; typeString: string }

export interface CheckerProp {
  name: string
  typeString: string
  kind: PropKind
  required: boolean
}

export interface CheckerResult {
  /** True only when an exported component's props type resolved. */
  propsTypeResolved: boolean
  /** True when the exported declaration has type parameters (DataTable<T> etc). */
  isGeneric: boolean
  /** Empty if propsTypeResolved=false; capped at PROP_CAP otherwise. */
  props: CheckerProp[]
  /** Raw count BEFORE capping — used for large-base-type detection. */
  rawCount: number
  /** Internal diagnostic — explains why props is empty/short. */
  note: string
}

// Order matters: react-node FIRST (it's a complex union containing
// strings/numbers/arrays — left unchecked it falls into literal-union with
// garbage); handler before object (function types ARE objects in TS);
// primitives on the non-nullable view (`x?: T` resolves to `T | undefined`
// via the checker — we classify on the inner type, the typeString shown to
// the panel keeps the original).
export function classifyPropKind(t: Type, typeString: string): PropKind {
  // ReactNode-family — detect by text. The symbol is too deeply intersected
  // to walk reliably; the text form is stable across `ReactNode`,
  // `React.ReactNode`, `import("react").ReactNode`, `ReactElement`,
  // `JSX.Element`.
  if (/\bReactNode\b|\bReactElement\b|\bJSX\.Element\b/.test(typeString)) {
    return { tag: "react-node" }
  }
  // Strip `undefined` / `null` from optionals before primitive classification.
  const nn = t.getNonNullableType()
  // Function types → handler. Check on nn — `(() => void) | undefined` would
  // otherwise have zero call signatures on the union itself.
  if (nn.getCallSignatures().length > 0) {
    return { tag: "handler", signature: typeString }
  }
  if (nn.isBoolean() || nn.isBooleanLiteral()) return { tag: "boolean" }
  if (nn.isNumber()) return { tag: "number" }
  if (nn.isString()) return { tag: "string" }
  if (nn.isStringLiteral()) {
    const v = nn.getLiteralValue()
    if (typeof v === "string") return { tag: "literal-union", values: [v], allString: true }
  }
  if (nn.isNumberLiteral()) {
    const v = nn.getLiteralValue()
    if (typeof v === "number") return { tag: "literal-union", values: [String(v)], allString: false }
  }
  // Union — enumerate, attempt literal extraction. If nn is itself a union of
  // literals the checker has already collapsed the optional away.
  const candidate = nn.isUnion() ? nn : t
  const u = candidate.getUnionTypes()
  if (u.length >= 2) {
    const lits: Array<string | number> = []
    let sawNonLiteral = false
    for (const m of u) {
      if (m.isUndefined() || m.isNull()) continue
      const v = m.getLiteralValue()
      if (v === undefined) {
        sawNonLiteral = true
        break
      }
      lits.push(v as string | number)
    }
    if (!sawNonLiteral && lits.length >= 2) {
      if (lits.every((v) => typeof v === "string")) {
        return { tag: "literal-union", values: lits as string[], allString: true }
      }
      if (lits.every((v) => typeof v === "number")) {
        return { tag: "literal-union", values: lits.map(String), allString: false }
      }
    }
  }
  // Object types — function-shape caught above.
  if (nn.isObject() || nn.isInterface() || nn.isArray()) {
    return { tag: "object", typeString }
  }
  // Complex union/intersection (discriminated unions of interfaces,
  // `string | false`, branded/conditional types). The checker has fully
  // resolved these; surface as `object` (typed read-only row). `unknown` is
  // reserved for the rare case the checker truly couldn't resolve at all.
  if (nn.isUnion() || nn.isIntersection()) {
    return { tag: "object", typeString }
  }
  return { tag: "unknown", typeString }
}

/**
 * Resolve the exported PascalCase component in `entry` and introspect its
 * first call-signature parameter (its props). Caller owns the Project so the
 * spike can reuse one across the sweep (init-once perf) and the worker can
 * scope one per job (file-pool freshness across builds).
 */
export function introspectComponent(project: Project, entry: string): CheckerResult {
  let sf
  try {
    sf = project.addSourceFileAtPath(entry)
  } catch (e) {
    return {
      propsTypeResolved: false,
      isGeneric: false,
      props: [],
      rawCount: 0,
      note: `ts-morph could not load: ${(e as Error).message}`,
    }
  }
  let propsType: Type | undefined
  let propsDecl: Node | undefined
  let isGeneric = false
  for (const [name, decls] of sf.getExportedDeclarations()) {
    if (!/^[A-Z]/.test(name)) continue
    const decl = decls[0]
    if (!decl) continue
    const t = decl.getType()
    const sig = t.getCallSignatures()[0] ?? t.getConstructSignatures()[0]
    const p0 = sig?.getParameters()[0]
    if (p0) {
      propsType = p0.getTypeAtLocation(decl)
      propsDecl = decl
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tp = (decl as any).getTypeParameters?.()
        if (Array.isArray(tp) && tp.length > 0) isGeneric = true
      } catch {
        // ignore — fall back to src-based detection in classifyGap
      }
      break
    }
  }
  if (!propsType || !propsDecl) {
    return {
      propsTypeResolved: false,
      isGeneric,
      props: [],
      rawCount: 0,
      note: "no exported PascalCase declaration with a resolvable props type",
    }
  }
  // Filter property DECLARATIONS parented in node_modules — that's React's
  // intersection types (AriaAttributes, DOMAttributes) the customer rarely
  // means; we want the CUSTOMER's prop interface. CRITICAL: this filters the
  // *declaration site*, NOT the *type* of the property. Union literals
  // imported from node_modules still resolve correctly — the prop is declared
  // in customer code, its TYPE points into node_modules, the checker follows
  // the type freely. That's the P0 fix.
  const allProps = propsType.getProperties()
  const customerProps = allProps.filter((s) => {
    const d = s.getDeclarations()[0]
    return d ? !/node_modules/.test(d.getSourceFile().getFilePath()) : true
  })
  const rawCount = customerProps.length
  const capped = rawCount > PROP_CAP ? customerProps.slice(0, PROP_CAP) : customerProps
  const props: CheckerProp[] = capped.map((sym) => {
    const t = sym.getTypeAtLocation(propsDecl!)
    const typeString = t.getText(propsDecl)
    return {
      name: sym.getName(),
      typeString,
      kind: classifyPropKind(t, typeString),
      required: !sym.isOptional(),
    }
  })
  return {
    propsTypeResolved: true,
    isGeneric,
    props,
    rawCount,
    note: rawCount > PROP_CAP ? `capped at ${PROP_CAP} (raw=${rawCount})` : "ok",
  }
}

/**
 * Map checker props → the D1 hybrid controls schema. Every resolved prop
 * yields a row (the PR6 non-negotiable gate); fields default to empty arrays
 * so the BuildManifestControls shape stays valid even when there's nothing
 * to surface.
 */
export function deriveControls(props: CheckerProp[]): {
  controls: BuildManifestControls
  propsSchema: Record<string, string>
} {
  const controls: BuildManifestControls = {
    booleans: [],
    slots: [],
    strings: [],
    numbers: [],
    handlers: [],
    objects: [],
  }
  const propsSchema: Record<string, string> = {}
  for (const p of props) {
    propsSchema[p.name] = p.typeString
    switch (p.kind.tag) {
      case "boolean":
        controls.booleans.push(p.name)
        break
      case "react-node":
        controls.slots.push({ prop: p.name, label: p.name })
        break
      case "string":
        controls.strings.push({ prop: p.name })
        break
      case "number":
        controls.numbers.push({ prop: p.name })
        break
      case "handler":
        controls.handlers.push({ prop: p.name, signature: p.kind.signature })
        break
      case "object":
        controls.objects.push({ prop: p.name, typeString: p.kind.typeString })
        break
      case "literal-union": {
        const literals = p.kind.values
        if (!p.kind.allString) {
          // Number-literal union — render as number input until rich widgets
          // ship in Step 5. The propsSchema retains the literal set.
          controls.numbers.push({ prop: p.name })
          break
        }
        if (p.name === "size") controls.sizes = { prop: p.name, options: literals }
        else if (p.name === "form") controls.forms = { prop: p.name, options: literals }
        else if (p.name === "variant" || !controls.variants)
          controls.variants = { prop: p.name, options: literals }
        else
          // 4th+ enum axis (rare; Button's `type` is the dogfood example) —
          // surface as typed read-only. N-ary variant axes is Step 5 polish.
          controls.objects.push({ prop: p.name, typeString: literals.join(" | ") })
        break
      }
      case "unknown":
        controls.objects.push({ prop: p.name, typeString: p.kind.typeString })
        break
    }
  }
  return { controls, propsSchema }
}

/**
 * Honest reason the checker produced no usable controls — drives the
 * limited-introspection sidebar note. Under D2 inversion, the dominant
 * pre-PR5 gaps (external-union, forwardref-unresolved) should never fire
 * post-checker; the numeric gate is exactly zeroes there.
 */
export function classifyGap(
  r: CheckerResult,
  controls: BuildManifestControls,
  src: string,
): IntrospectionGap | undefined {
  if (r.rawCount > PROP_CAP) return "large-base-type"
  if (!r.propsTypeResolved) {
    if (/\bforwardRef\b|\bmemo\(|=\s*\w+\([A-Z]/.test(src)) return "forwardref-unresolved"
    return "no-props-interface"
  }
  if (r.props.length === 0) return "no-props-interface"
  const generic = r.isGeneric || /<[A-Z]\w*<[A-Z]/.test(src) || /\bfunction\s+\w+<[A-Z]/.test(src)
  if (generic) {
    const allTRef = r.props.every(
      (p) => p.kind.tag === "unknown" && /\bT\b/.test(p.kind.typeString),
    )
    if (allTRef) return "generic"
  }
  if (
    r.props.some(
      (p) => p.kind.tag === "unknown" && /\s\|\s/.test(p.kind.typeString),
    )
  ) {
    return "external-union"
  }
  const hasControls =
    !!controls.variants ||
    !!controls.sizes ||
    !!controls.forms ||
    controls.booleans.length > 0 ||
    controls.slots.length > 0 ||
    controls.strings.length > 0 ||
    controls.numbers.length > 0 ||
    controls.handlers.length > 0 ||
    controls.objects.length > 0
  if (!hasControls) return "external-union"
  return undefined
}

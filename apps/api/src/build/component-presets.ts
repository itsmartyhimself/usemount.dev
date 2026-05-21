// <Component>.usemount.tsx preset parser — STATIC AST ONLY. NEVER import() / eval.
//
// Step 5.5 (Component override file). A power user drops a sibling file next to
// a component — `Button.usemount.tsx` next to `Button.tsx` — exporting named
// preset scenarios: fixed prop combinations surfaced as quick-picks in the
// properties panel. This is the v1 override scope per dashboard-build-plan
// Step 5 ("Document the override file ... for power users") and
// architecture-brief §body (48/137/289/309). The §11.4 "v2" tag is about
// per-component PROVIDER wrappers, NOT this presets override (see <pr id="12">
// <deviations> in migration-plan.md).
//
// The file is customer source code; the worker runs in the same process as the
// lease loop, so `import("Button.usemount.tsx")` would be RCE on the worker.
// Static AST + literal-only acceptance is THE control — identical posture to
// mount-config.ts (audited safe). We only ever read literal values; any
// Identifier reference / CallExpression / template substitution / JSX / spread
// is rejected (the preset that contains it is skipped, never evaluated).
//
// Enrichment, not survival (architecture-brief §body): a malformed override
// file must NEVER fail the component build. resolveComponentPresets is fully
// internally guarded — it returns {} presets + hints, never throws. The worker
// surfaces the hints in the build log.
//
// Convention (apps/web/CONVENTIONS.md): `export const presets = { "<name>":
// { <prop>: <literal>, ... }, ... }`. Each preset value must be an object
// literal of literal props (string / number / boolean / null / nested literal
// object / literal array). Slots (ReactNode) and runtime values cannot be
// expressed as literals and are out of scope for v1 presets.

import { Project, SyntaxKind, type Node } from "ts-morph"
import { existsSync } from "node:fs"
import path from "node:path"

export interface ResolvedPresets {
  // name → props object. Maps 1:1 onto BuildManifest.states (→ states_json).
  presets: Record<string, Record<string, unknown>>
  // Diagnostics for the build log (skipped presets/props, parse failures).
  hints: string[]
}

const EMPTY: ResolvedPresets = { presets: {}, hints: [] }

/** Sibling override path for a component entry: `Button.tsx` → `Button.usemount.tsx`. */
export function presetFilePath(componentEntry: string): string {
  const dir = path.dirname(componentEntry)
  const base = path.basename(componentEntry).replace(/\.tsx$/, "")
  return path.join(dir, `${base}.usemount.tsx`)
}

/**
 * Read named preset scenarios from a component's sibling `*.usemount.tsx`.
 * Never throws — returns {} presets (+ hints) on any failure so a broken
 * override file degrades to "no presets", not a failed component.
 */
export function resolveComponentPresets(componentEntry: string): ResolvedPresets {
  const filePath = presetFilePath(componentEntry)
  if (!existsSync(filePath)) return EMPTY

  try {
    const project = new Project({ skipAddingFilesFromTsConfig: true })
    const sf = project.addSourceFileAtPath(filePath)

    // Only `export const presets = { ... }` is honored (documented convention).
    let presetsObj: Node | undefined
    for (const [name, decls] of sf.getExportedDeclarations()) {
      if (name !== "presets") continue
      presetsObj = decls[0]
        ?.asKind(SyntaxKind.VariableDeclaration)
        ?.getInitializer()
      break
    }
    if (!presetsObj) {
      return {
        presets: {},
        hints: [
          `${path.basename(filePath)}: no \`export const presets = { ... }\` found`,
        ],
      }
    }

    const obj = presetsObj.asKind(SyntaxKind.ObjectLiteralExpression)
    if (!obj) {
      return {
        presets: {},
        hints: [
          `${path.basename(filePath)}: \`presets\` must be an object literal, got ${presetsObj.getKindName()}`,
        ],
      }
    }

    const presets: Record<string, Record<string, unknown>> = {}
    const hints: string[] = []
    for (const prop of obj.getProperties()) {
      const ps = prop.asKind(SyntaxKind.PropertyAssignment)
      if (!ps) {
        hints.push(
          `${path.basename(filePath)}: skipped a non-PropertyAssignment preset entry (no shorthand/spread/computed)`,
        )
        continue
      }
      const presetName = propName(ps)
      const valueNode = ps.getInitializerOrThrow()
      const valueObj = valueNode.asKind(SyntaxKind.ObjectLiteralExpression)
      if (!valueObj) {
        hints.push(
          `preset "${presetName}": skipped — value must be a props object literal, got ${valueNode.getKindName()}`,
        )
        continue
      }
      const read = readPropsObject(valueObj)
      if (!read.ok) {
        hints.push(`preset "${presetName}": skipped — ${read.reason}`)
        continue
      }
      presets[presetName] = read.value
    }
    return { presets, hints }
  } catch (e) {
    return {
      presets: {},
      hints: [`${path.basename(filePath)}: parse failed — ${(e as Error).message}`],
    }
  }
}

/** Property name as written, unwrapping a string-literal key (`"Primary Large"`). */
function propName(ps: import("ts-morph").PropertyAssignment): string {
  const nameNode = ps.getNameNode()
  const str = nameNode.asKind(SyntaxKind.StringLiteral)
  return str ? str.getLiteralValue() : nameNode.getText()
}

type ReadResult<T> = { ok: true; value: T } | { ok: false; reason: string }

/** Read an object literal of literal props. Fail-closed on the first non-literal. */
function readPropsObject(
  obj: import("ts-morph").ObjectLiteralExpression,
): ReadResult<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const prop of obj.getProperties()) {
    const ps = prop.asKind(SyntaxKind.PropertyAssignment)
    if (!ps) {
      return {
        ok: false,
        reason: "only plain props allowed (no shorthand/spread/computed)",
      }
    }
    const key = propName(ps)
    const read = readLiteral(ps.getInitializerOrThrow())
    if (!read.ok) return { ok: false, reason: `prop "${key}": ${read.reason}` }
    out[key] = read.value
  }
  return { ok: true, value: out }
}

/** Accept only literal values; reject anything that would require evaluation. */
function readLiteral(node: Node): ReadResult<unknown> {
  const str = node.asKind(SyntaxKind.StringLiteral)
  if (str) return { ok: true, value: str.getLiteralValue() }

  const tmpl = node.asKind(SyntaxKind.NoSubstitutionTemplateLiteral)
  if (tmpl) return { ok: true, value: tmpl.getLiteralValue() }

  const num = node.asKind(SyntaxKind.NumericLiteral)
  if (num) return { ok: true, value: num.getLiteralValue() }

  const kind = node.getKind()
  if (kind === SyntaxKind.TrueKeyword) return { ok: true, value: true }
  if (kind === SyntaxKind.FalseKeyword) return { ok: true, value: false }
  if (kind === SyntaxKind.NullKeyword) return { ok: true, value: null }

  // Negative number: `-1` is a PrefixUnaryExpression over a NumericLiteral.
  const unary = node.asKind(SyntaxKind.PrefixUnaryExpression)
  if (unary && unary.getOperatorToken() === SyntaxKind.MinusToken) {
    const operand = unary.getOperand().asKind(SyntaxKind.NumericLiteral)
    if (operand) return { ok: true, value: -operand.getLiteralValue() }
  }

  const arr = node.asKind(SyntaxKind.ArrayLiteralExpression)
  if (arr) {
    const items: unknown[] = []
    for (const el of arr.getElements()) {
      const r = readLiteral(el)
      if (!r.ok) return { ok: false, reason: `array element: ${r.reason}` }
      items.push(r.value)
    }
    return { ok: true, value: items }
  }

  const obj = node.asKind(SyntaxKind.ObjectLiteralExpression)
  if (obj) return readPropsObject(obj)

  return {
    ok: false,
    reason: `value must be a literal (string/number/boolean/null/object/array), got ${node.getKindName()}`,
  }
}

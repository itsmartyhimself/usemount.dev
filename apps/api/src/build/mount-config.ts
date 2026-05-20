// mount.config.ts parser — STATIC AST ONLY. NEVER import() / eval.
//
// The config file is customer source code; the worker runs it in the same
// process as the lease loop. `import("mount.config.ts")` is therefore RCE on
// the worker (and on the iframe at 4.3 when the same config drives runtime
// behaviour). Static AST + literal-only acceptance + fail-closed is THE
// control. CallExpression / Identifier reference / template substitution /
// spread / computed-name → throw. The only legitimate config shape is an
// object literal with three optional string-literal-or-string-array values:
//   componentsDir: string
//   globalsCss:    string
//   hidden:        string[]
//
// Fallback chain when no mount.config.ts: src/components → components →
// app/components (architecture-brief §3 Discovery). Worker writes
// build_jobs.error='no_components_dir' if none exist.

import { Project, SyntaxKind, type Node } from "ts-morph"
import { existsSync } from "node:fs"
import path from "node:path"

export interface MountConfig {
  componentsDir?: string
  globalsCss?: string
  hidden?: string[]
}

export interface ResolvedMount {
  config: MountConfig
  // Was the result obtained from auto-detect (no mount.config.ts present)?
  fallbackUsed: boolean
  // Absolute path on disk (or null if resolution failed).
  resolvedComponentsDir: string | null
  resolvedGlobalsCss: string | null
}

const ALLOWED_KEYS = new Set(["componentsDir", "globalsCss", "hidden"])
const COMPONENTS_DIR_FALLBACKS = ["src/components", "components", "app/components"]
const GLOBALS_CSS_FALLBACKS = [
  "app/globals.css",
  "app/global.css",
  "src/app/globals.css",
  "styles/globals.css",
]

export function parseMountConfig(workDir: string): ResolvedMount {
  const configPath = path.join(workDir, "mount.config.ts")
  let config: MountConfig = {}
  let fallbackUsed = true
  if (existsSync(configPath)) {
    config = parseStaticConfig(configPath)
    fallbackUsed = false
  }

  const dirCandidates = config.componentsDir
    ? [config.componentsDir]
    : COMPONENTS_DIR_FALLBACKS
  let resolvedComponentsDir: string | null = null
  for (const rel of dirCandidates) {
    const abs = path.join(workDir, rel)
    if (existsSync(abs)) {
      resolvedComponentsDir = abs
      break
    }
  }

  let resolvedGlobalsCss: string | null = null
  if (config.globalsCss) {
    const abs = path.join(workDir, config.globalsCss)
    if (existsSync(abs)) resolvedGlobalsCss = abs
  } else {
    for (const rel of GLOBALS_CSS_FALLBACKS) {
      const abs = path.join(workDir, rel)
      if (existsSync(abs)) {
        resolvedGlobalsCss = abs
        break
      }
    }
  }

  return { config, fallbackUsed, resolvedComponentsDir, resolvedGlobalsCss }
}

function parseStaticConfig(configPath: string): MountConfig {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    // No compiler options needed — we never evaluate, only walk the AST.
  })
  const sf = project.addSourceFileAtPath(configPath)
  const config: MountConfig = {}

  // Prefer `export default { ... }`; fall back to `export const config = { ... }`.
  // Both must be raw object literals — no Identifier reference, no
  // satisfies-with-call, no spread.
  const defaultSym = sf.getDefaultExportSymbol()
  if (defaultSym) {
    for (const d of defaultSym.getDeclarations()) {
      const exportAssign = d.asKind(SyntaxKind.ExportAssignment)
      const expr = exportAssign?.getExpression()
      if (expr) {
        readObjectLiteral(expr, config)
        return config
      }
    }
  }
  for (const [name, decls] of sf.getExportedDeclarations()) {
    if (name !== "config") continue
    const init = decls[0]
      ?.asKind(SyntaxKind.VariableDeclaration)
      ?.getInitializer()
    if (init) {
      readObjectLiteral(init, config)
      return config
    }
  }
  throw new Error("mount.config.ts: no `export default { ... }` or `export const config = { ... }`")
}

function readObjectLiteral(node: Node, into: MountConfig): void {
  const obj = node.asKind(SyntaxKind.ObjectLiteralExpression)
  if (!obj) {
    throw new Error(
      `mount.config.ts: export must be a raw object literal, got ${node.getKindName()}`,
    )
  }
  for (const prop of obj.getProperties()) {
    const ps = prop.asKind(SyntaxKind.PropertyAssignment)
    if (!ps) {
      throw new Error(
        `mount.config.ts: only PropertyAssignment allowed (no shorthand/spread/computed), got ${prop.getKindName()}`,
      )
    }
    const key = ps.getName()
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`mount.config.ts: key '${key}' not in allowed set [${[...ALLOWED_KEYS].join(", ")}]`)
    }
    const val = ps.getInitializerOrThrow()
    if (key === "componentsDir" || key === "globalsCss") {
      const s = val.asKind(SyntaxKind.StringLiteral)
      if (!s) {
        throw new Error(
          `mount.config.ts: '${key}' must be a string literal, got ${val.getKindName()}`,
        )
      }
      into[key] = s.getLiteralValue()
    } else if (key === "hidden") {
      const arr = val.asKind(SyntaxKind.ArrayLiteralExpression)
      if (!arr) {
        throw new Error(
          `mount.config.ts: 'hidden' must be an array literal, got ${val.getKindName()}`,
        )
      }
      const items: string[] = []
      for (const el of arr.getElements()) {
        const s = el.asKind(SyntaxKind.StringLiteral)
        if (!s) {
          throw new Error(
            `mount.config.ts: 'hidden' elements must be string literals, got ${el.getKindName()}`,
          )
        }
        items.push(s.getLiteralValue())
      }
      into.hidden = items
    }
  }
}

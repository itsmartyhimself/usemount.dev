// BUILD-side manifest — what the Step-4.2 build worker emits per component.
//
// Deliberately distinct from the RENDER-side ComponentManifest<P> in
// ./manifest.ts. That one has `render: (props) => ReactNode` — an in-host
// React concept. The build worker runs in apps/api with no React host: it
// emits METADATA + a pointer to a bundled JS artifact in Storage; the iframe
// runtime (Step 4.3) is what supplies `render`. Conflating the two is the
// "manifest-shape duality" the 4.0 spike surfaced as the primary Step-4
// re-plan input (migration-plan.md <pr id="4"> / <addendum to="4">).
//
// Every field maps 1:1 to a public.component_manifests column
// (supabase/migrations/0001_init.sql) — the comment on each line is the column.

// One control row per resolved prop. The 4.3 canvas panel renders each kind:
//   variants/sizes/forms — exclusive toggle (one option per row)
//   booleans             — switch
//   slots                — slot mount point (ReactNode)
//   strings              — text input (interactive)
//   numbers              — number input (interactive)
//   handlers             — typed read-only row showing the function signature
//                          (rich invoke widget = Step 5)
//   objects              — typed read-only row showing the type string
//                          (rich JSON editor = Step 5)
// The PR6 D1 hybrid scope: every resolved prop yields a row (no empty panels
// when props exist); rich widgets for enum/bool/slot/string/number, typed
// read-only rows for handler/object until Step 5. The 4.3 canvas panel must
// know how to draw all eight row kinds.
export interface BuildManifestControls {
  variants?: { prop: string; options: string[] }
  sizes?: { prop: string; options: string[] }
  forms?: { prop: string; options: string[] }
  booleans: string[]
  slots: Array<{ prop: string; label: string }>
  // Interactive widgets added in PR6 (D1 hybrid).
  strings: Array<{ prop: string }>
  numbers: Array<{ prop: string }>
  // Typed read-only rows added in PR6 (D1 hybrid). The 4.3 panel shows
  // `prop: signature` / `prop: typeString` so the user always sees the prop
  // exists and its type, even before Step 5 ships interactive widgets.
  handlers: Array<{ prop: string; signature: string }>
  objects: Array<{ prop: string; typeString: string }>
}

// `component`  — a normal client component, previewable.
// `maybe-rsc`  — no "use client" directive; may be a Server Component (v1
//                does not render RSCs — architecture-brief §3 failure mode 1).
// `unsupported`— detected but cannot be previewed (e.g. build-fail); shown in
//                the sidebar with the reason so the customer knows we saw it.
export type BuildManifestKind = "component" | "maybe-rsc" | "unsupported"

export interface BuildManifest {
  slug: string // → component_manifests.slug (UNIQUE per instance)
  folderPath: string // → folder_path
  title: string // → title
  kind: BuildManifestKind // → kind
  // controls → variants_json (the canvas reads this for the toggles panel):
  controls: BuildManifestControls
  // free-form per-prop "type name" map (string|enum|boolean|ReactNode|…),
  // for the limited-introspection UI + future enrichment → props_schema_json:
  propsSchema: Record<string, string>
  // named scenario presets (Component.canvas.tsx overrides, Step 5) →
  // states_json. Empty until override files are honored.
  states: Record<string, unknown>
  artifactUrl: string | null // → artifact_url (Supabase Storage; null if build-fail)
  sourceHash: string // → source_hash (skip-rebuild when unchanged)
  // Why introspection produced no controls, when it didn't. Non-persisted
  // diagnostic (NOT a DB column) — drives the "limited introspection" sidebar
  // note and the 4.2 introspection-rate work. undefined = fully introspected.
  introspectionGap?: IntrospectionGap
}

// The honest reasons rdt yields zero/again controls on a real component.
// Measured on the 4.0b REV-Plugin pass; the 4.2 worker targets these.
export type IntrospectionGap =
  | "no-props-interface" // no resolvable props type (helper/context file, not a component)
  | "forwardref-unresolved" // exported via forwardRef/HOC, props type not followed
  | "external-union" // union/enum imported from node_modules — rdt can't read literals
  | "large-base-type" // intersects a huge base (Radix Slot etc.) → prop-count blow-up
  | "generic" // generic component (<DataTable<T>>) — render at default, no T toggle

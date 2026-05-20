// Runtime manifest the canvas operates on after the PR7 D2 collapse.
//
// Before PR7 (demo era): `ComponentManifest<P>` carried a `render: (props) =>
// ReactNode` function — every manifest mounted inline in the host bundle.
// PR6's build-side `BuildManifest` deliberately lived in a separate type
// because the build worker has no React host (`build-manifest.ts` opening
// comment).
//
// PR7 collapses the two: the iframe runtime IS the render path, so the
// build-side BuildManifest fields + the DB row id + a synthesized
// `defaultProps` (see ./synthesize-defaults.ts) is everything the canvas
// needs. The render field is gone — `<IframeMount manifestId={...} props={...}/>`
// is the new "render".
//
// One shape, one source of truth: the `component_manifests` row shipped by
// the build worker IS the manifest the canvas reads.

import type { BuildManifest } from "./build-manifest.js"

export interface ComponentManifest extends BuildManifest {
  /** component_manifests.id (DB row uuid). The iframe route uses this. */
  id: string
  /** component_manifests.instance_id. Component_views inserts reference it. */
  instanceId: string
  /**
   * Synthesized client-side from `controls` (see ./synthesize-defaults.ts).
   * Mirrors the role `defaultProps` played in the pre-PR7 ComponentManifest<P>:
   * the canvas's initial prop state on selection change + the reset target
   * for the panel's "Reset to Default" button.
   */
  defaultProps: Record<string, unknown>
}

// Type-erased alias — the registry holds these opaquely; the iframe is the
// only consumer that sees the actual prop shape, and it gets them as a plain
// `Record<string, unknown>` over postMessage.
export type AnyComponentManifest = ComponentManifest

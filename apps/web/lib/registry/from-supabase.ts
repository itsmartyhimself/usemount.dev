// Convert live `component_manifests` rows into the sidebar Registry shape
// the existing UI consumes. Server-side fetch — called from the InstancePage
// route handler with the user's session (RLS gates the visible rows to
// workspace members).
//
// The build worker (PR6) populates one row per component under an instance.
// PR7 collapses the manifest duality (see packages/shared/src/manifest.ts):
// the runtime ComponentManifest IS the row + synthesized defaults. The
// sidebar treats every "kind=component" row as a normal leaf; kind=maybe-rsc
// and kind=unsupported are shown but disabled (architecture-brief §3 failure
// modes 1 + 6).
//
// Folder structure: each unique `folder_path` becomes one folder under the
// "library" section. We don't try to reconstruct nested folder hierarchy
// from path parts in v1 — the dogfood has one component per direct folder
// already (`apps/web/components/live/button/`, `.../input/`, etc.), so a
// single-level grouping reads correctly. Nested folders are a Step 5 polish.

import type { SupabaseClient } from "@supabase/supabase-js"
import {
  type BuildManifestControls,
  type BuildManifestKind,
  type ComponentManifest,
  synthesizeDefaultProps,
} from "@usemount/shared"
import type {
  FolderRecord,
  LeafRecord,
  Registry,
  SectionRecord,
} from "./types"

interface ComponentManifestRow {
  id: string
  instance_id: string
  slug: string
  folder_path: string | null
  title: string | null
  kind: string | null
  variants_json: BuildManifestControls
  states_json: Record<string, unknown>
  props_schema_json: Record<string, string>
  artifact_url: string | null
  source_hash: string | null
}

const LIBRARY_SECTION: SectionRecord = {
  id: "library",
  label: "Components",
  kind: "folders",
}

/** Default empty controls so a partial / missing variants_json never crashes. */
const EMPTY_CONTROLS: BuildManifestControls = {
  booleans: [],
  slots: [],
  strings: [],
  numbers: [],
  handlers: [],
  objects: [],
}

function safeKind(raw: string | null): BuildManifestKind {
  if (raw === "component" || raw === "maybe-rsc" || raw === "unsupported") {
    return raw
  }
  return "unsupported"
}

function safeControls(raw: unknown): BuildManifestControls {
  if (!raw || typeof raw !== "object") return EMPTY_CONTROLS
  const r = raw as Partial<BuildManifestControls>
  return {
    variants: r.variants,
    sizes: r.sizes,
    forms: r.forms,
    booleans: Array.isArray(r.booleans) ? r.booleans : [],
    slots: Array.isArray(r.slots) ? r.slots : [],
    strings: Array.isArray(r.strings) ? r.strings : [],
    numbers: Array.isArray(r.numbers) ? r.numbers : [],
    handlers: Array.isArray(r.handlers) ? r.handlers : [],
    objects: Array.isArray(r.objects) ? r.objects : [],
  }
}

/**
 * Build the in-memory manifest map keyed by DB row id. The canvas controls
 * provider reads from here when the selectedId changes.
 */
export function buildManifestMap(
  rows: ComponentManifestRow[],
): Map<string, ComponentManifest> {
  const out = new Map<string, ComponentManifest>()
  for (const r of rows) {
    const controls = safeControls(r.variants_json)
    out.set(r.id, {
      id: r.id,
      instanceId: r.instance_id,
      slug: r.slug,
      folderPath: r.folder_path ?? "",
      title: r.title ?? r.slug,
      kind: safeKind(r.kind),
      controls,
      propsSchema: r.props_schema_json ?? {},
      states: r.states_json ?? {},
      artifactUrl: r.artifact_url,
      sourceHash: r.source_hash ?? "",
      defaultProps: synthesizeDefaultProps(controls),
    })
  }
  return out
}

/**
 * Build the sidebar tree from the manifest rows. Folders are derived from
 * each row's `folder_path`; leaves are one per row.
 */
export function buildRegistry(
  rows: ComponentManifestRow[],
  options: {
    user?: { name: string; email: string; avatarUrl?: string }
    team?: { id: string; name: string; plan: string }
  } = {},
): Registry {
  const folderById = new Map<string, FolderRecord>()
  const leaves: LeafRecord[] = []
  for (const r of rows) {
    const folderPath = r.folder_path ?? ""
    const folderId = folderPath || "root"
    if (!folderById.has(folderId)) {
      const display = folderPath
        ? folderPath.split("/").pop() || folderPath
        : "Components"
      folderById.set(folderId, {
        id: folderId,
        sectionId: "library",
        name: display,
        order: folderById.size,
      })
    }
    const kind = safeKind(r.kind)
    const disabled = kind !== "component" || !r.artifact_url
    leaves.push({
      id: r.id,
      name: r.title ?? r.slug,
      kind: "component",
      folderId,
      sectionId: "library",
      sourcePath: r.folder_path ?? undefined,
      order: leaves.length,
      disabled,
      // Step 5.6 — carry the build classification so the sidebar can show the
      // greyed leaf's disposition note ("Server component — not supported").
      manifestKind: kind,
    })
  }
  // Stable order: alphabetical within each folder, folders alphabetical.
  const folders = Array.from(folderById.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  )
  folders.forEach((f, i) => {
    f.order = i
  })
  leaves.sort((a, b) => {
    const af = a.folderId ?? ""
    const bf = b.folderId ?? ""
    if (af !== bf) return af.localeCompare(bf)
    return a.name.localeCompare(b.name)
  })
  leaves.forEach((l, i) => {
    l.order = i
  })
  return {
    sections: [LIBRARY_SECTION],
    folders,
    leaves,
    topPages: [],
    team: options.team ?? { id: "", name: "", plan: "" },
    user: options.user ?? { name: "", email: "" },
  }
}

export interface InstanceRegistry {
  registry: Registry
  manifests: Map<string, ComponentManifest>
}

const EMPTY_INSTANCE_REGISTRY: InstanceRegistry = {
  registry: {
    sections: [LIBRARY_SECTION],
    folders: [],
    leaves: [],
    topPages: [],
    team: { id: "", name: "", plan: "" },
    user: { name: "", email: "" },
  },
  manifests: new Map(),
}

/**
 * Fetch the manifest rows for an instance + build both the sidebar registry
 * and the runtime manifest map. RLS gates visibility to workspace members.
 * Returns an empty-but-valid registry on error or missing instance so the
 * UI degrades to "no components yet" rather than throwing.
 */
export async function fetchInstanceRegistry(
  supabase: SupabaseClient,
  instanceId: string | null | undefined,
  options: { user?: { name: string; email: string; avatarUrl?: string } } = {},
): Promise<InstanceRegistry> {
  if (!instanceId) return EMPTY_INSTANCE_REGISTRY
  const { data, error } = await supabase
    .from("component_manifests")
    .select(
      "id, instance_id, slug, folder_path, title, kind, variants_json, states_json, props_schema_json, artifact_url, source_hash",
    )
    .eq("instance_id", instanceId)
  if (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[fetchInstanceRegistry]", error.message)
    }
    return EMPTY_INSTANCE_REGISTRY
  }
  const rows = (data ?? []) as ComponentManifestRow[]
  return {
    registry: buildRegistry(rows, options),
    manifests: buildManifestMap(rows),
  }
}

export function emptyInstanceRegistry(): InstanceRegistry {
  return EMPTY_INSTANCE_REGISTRY
}

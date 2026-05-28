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
// Folder structure: each `folder_path` is split into segments and one folder
// is created per segment with `parentId` links, so the sidebar renders a real
// nested tree (e.g. `components/ui/forms` → components › ui › forms). A leaf
// points at its full-path folder; intermediate folders hold only child folders.

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
  preview_artifact_url: string | null
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

/**
 * Sanitize an enum control's options. Stale manifests carried a leading ""
 * (an empty selectable row that also became the synthesized default — it read
 * as a blank pill). Strip blank/whitespace-only entries, and drop the whole
 * control when fewer than two real options remain: a 0/1-option toggle renders
 * no UI and would only leave the prop unset (String(undefined) → "undefined").
 */
function cleanEnumControl(
  control: { prop: string; options: string[] } | undefined,
): { prop: string; options: string[] } | undefined {
  if (!control || typeof control !== "object") return undefined
  const { prop, options } = control
  if (typeof prop !== "string" || !Array.isArray(options)) return undefined
  const cleaned = options.filter((o) => typeof o === "string" && o.trim() !== "")
  return cleaned.length >= 2 ? { prop, options: cleaned } : undefined
}

function safeControls(raw: unknown): BuildManifestControls {
  if (!raw || typeof raw !== "object") return EMPTY_CONTROLS
  const r = raw as Partial<BuildManifestControls>
  return {
    variants: cleanEnumControl(r.variants),
    sizes: cleanEnumControl(r.sizes),
    forms: cleanEnumControl(r.forms),
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
      previewArtifactUrl: r.preview_artifact_url,
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
  // Ensure a FolderRecord exists for `path` AND every ancestor segment, linked
  // by parentId. Idempotent (deduped by id = the path).
  const ensureFolderPath = (path: string) => {
    if (folderById.has(path)) return
    const segs = path.split("/")
    const parentPath = segs.slice(0, -1).join("/")
    if (parentPath) ensureFolderPath(parentPath)
    folderById.set(path, {
      id: path,
      sectionId: "library",
      name: segs[segs.length - 1] || path,
      parentId: parentPath || undefined,
      order: folderById.size,
    })
  }
  const leaves: LeafRecord[] = []
  for (const r of rows) {
    const folderPath = r.folder_path ?? ""
    let folderId: string
    if (folderPath) {
      ensureFolderPath(folderPath)
      folderId = folderPath
    } else {
      folderId = "root"
      if (!folderById.has("root")) {
        folderById.set("root", {
          id: "root",
          sectionId: "library",
          name: "Components",
          order: folderById.size,
        })
      }
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

const MANIFEST_SELECT =
  "id, instance_id, slug, folder_path, title, kind, variants_json, states_json, props_schema_json, artifact_url, preview_artifact_url, source_hash"

type RegistryOptions = {
  user?: { name: string; email: string; avatarUrl?: string }
}

/**
 * Fetch the manifest rows + build the registry, THROWING on a Supabase error.
 * The client-side reseed (sidebar-panel-provider) uses this so a transient
 * error skips the update — keeping the live sidebar — instead of overwriting
 * it with empty. RLS gates visibility to workspace members.
 */
export async function fetchInstanceRegistryOrThrow(
  supabase: SupabaseClient,
  instanceId: string | null | undefined,
  options: RegistryOptions = {},
): Promise<InstanceRegistry> {
  if (!instanceId) return EMPTY_INSTANCE_REGISTRY
  const { data, error } = await supabase
    .from("component_manifests")
    .select(MANIFEST_SELECT)
    .eq("instance_id", instanceId)
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as ComponentManifestRow[]
  return {
    registry: buildRegistry(rows, options),
    manifests: buildManifestMap(rows),
  }
}

/**
 * Like the above but degrades to an empty-but-valid registry on error or
 * missing instance — the server-side seed path (InstancePage) must always
 * render, even as "no components yet", rather than throwing.
 */
export async function fetchInstanceRegistry(
  supabase: SupabaseClient,
  instanceId: string | null | undefined,
  options: RegistryOptions = {},
): Promise<InstanceRegistry> {
  try {
    return await fetchInstanceRegistryOrThrow(supabase, instanceId, options)
  } catch (e) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[fetchInstanceRegistry]", (e as Error).message)
    }
    return EMPTY_INSTANCE_REGISTRY
  }
}

export function emptyInstanceRegistry(): InstanceRegistry {
  return EMPTY_INSTANCE_REGISTRY
}

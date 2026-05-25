// component_manifests UPSERT + stale-slug DELETE for the build worker.
//
// UPSERT on (instance_id, slug) — the 0001 schema's UNIQUE constraint there
// makes this a single round-trip. Stale slugs (slugs that exist in the DB
// but are NOT in the current build's output) get deleted in a follow-up so
// the sidebar doesn't accumulate ghost entries forever when a customer
// renames or removes a component.
//
// The variants_json column carries the entire BuildManifestControls shape
// the 4.3 canvas reads — keep the field naming exact so the panel can
// consume it directly via a typed cast.

import { supabaseAdmin } from "../supabase/admin.js"
import type { BuildManifest } from "@usemount/shared"

export interface SyncResult {
  upserted: number
  deleted: number
}

export async function syncManifests(opts: {
  instanceId: string
  manifests: BuildManifest[]
}): Promise<SyncResult> {
  const rows = opts.manifests.map((m) => ({
    instance_id: opts.instanceId,
    slug: m.slug,
    folder_path: m.folderPath,
    title: m.title,
    kind: m.kind,
    variants_json: m.controls,
    states_json: m.states,
    props_schema_json: m.propsSchema,
    artifact_url: m.artifactUrl,
    preview_artifact_url: m.previewArtifactUrl,
    source_hash: m.sourceHash,
  }))

  if (rows.length > 0) {
    const { error: upErr } = await supabaseAdmin()
      .from("component_manifests")
      .upsert(rows, { onConflict: "instance_id,slug" })
    if (upErr) throw new Error(`component_manifests upsert: ${upErr.message}`)
  }

  // Read existing slugs for this instance, drop any not in the current set.
  const { data: existing, error: selErr } = await supabaseAdmin()
    .from("component_manifests")
    .select("id, slug")
    .eq("instance_id", opts.instanceId)
  if (selErr) throw new Error(`component_manifests select-existing: ${selErr.message}`)

  const currentSet = new Set(rows.map((r) => r.slug))
  const stale = (existing ?? []).filter((r) => !currentSet.has(r.slug))
  let deleted = 0
  if (stale.length > 0) {
    const { error: delErr } = await supabaseAdmin()
      .from("component_manifests")
      .delete()
      .in(
        "id",
        stale.map((r) => r.id),
      )
    if (delErr) throw new Error(`component_manifests stale-delete: ${delErr.message}`)
    deleted = stale.length
  }

  return { upserted: rows.length, deleted }
}

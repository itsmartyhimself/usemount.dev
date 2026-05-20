// Server-side signed URL helpers for the Supabase `component-artifacts`
// bucket (Step 4.3 D3 = 15-min TTL).
//
// The bucket is PRIVATE (Step 4.2-prep) — service_role signs each download
// URL ahead of serving the iframe HTML. The browser never sees service_role;
// it sees only short-lived signed URLs the route handler embedded in the
// HTML.
//
// Storage object keys (PR6 storage.ts):
//   <instanceId>/<slug>.<source_hash>.js   — per-component bundle
//   <instanceId>/<slug>.<source_hash>.css  — per-component CSS (optional)
//   <instanceId>/globals.<source_hash>.css — instance globals (worker emits
//     `slug: "globals"` so the path is predictable; hash changes per build)
//
// `import "server-only"` guards against accidental client import — the
// service-role key MUST NOT leak to the browser bundle.

import "server-only"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"

const BUCKET = "component-artifacts"
/** D3: 15-minute TTL on signed URLs (architecture-brief Step 4.3 §). */
export const SIGNED_URL_TTL_SECONDS = 15 * 60

/**
 * Sign a single Storage object path. Returns the absolute URL (host included).
 * Throws if the object is missing or signing fails — the route handler turns
 * that into a 4xx HTML response.
 */
export async function signStoragePath(path: string): Promise<string> {
  const admin = createSupabaseAdminClient()
  const { data, error } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS)
  if (error || !data) {
    throw new Error(`signStoragePath ${path}: ${error?.message ?? "no url"}`)
  }
  return data.signedUrl
}

/**
 * Locate and sign the current instance globals.css. The worker uploads it
 * with a hash-pinned key (`<instanceId>/globals.<hash>.css`) and overwrites
 * on each build; the hash isn't persisted to a DB column, so the route picks
 * the freshest globals.* CSS object in the instance's prefix (sorted by
 * updated_at DESC).
 *
 * Returns null if no globals.css is present (e.g., a build that couldn't
 * resolve a globals.css path).
 */
export async function signGlobalsCss(
  instanceId: string,
): Promise<string | null> {
  const admin = createSupabaseAdminClient()
  const { data, error } = await admin.storage
    .from(BUCKET)
    .list(instanceId, {
      limit: 100,
      sortBy: { column: "updated_at", order: "desc" },
    })
  if (error) {
    throw new Error(`signGlobalsCss list ${instanceId}: ${error.message}`)
  }
  const match = (data ?? []).find((f) => /^globals\.[a-f0-9]+\.css$/i.test(f.name))
  if (!match) return null
  return signStoragePath(`${instanceId}/${match.name}`)
}

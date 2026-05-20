// Server-side signed URL helpers for the Supabase `component-artifacts`
// bucket (Step 4.3 D3 = 15-min TTL).
//
// The bucket is PRIVATE (Step 4.2-prep) — service_role signs each download
// URL ahead of serving the iframe HTML. The browser never sees service_role;
// it sees only short-lived signed URLs the route handler embedded in the
// HTML.
//
// Storage object keys (PR6 storage.ts + PR11 providers.ts):
//   <instanceId>/<slug>.<source_hash>.js     — per-component bundle
//   <instanceId>/<slug>.<source_hash>.css    — per-component CSS (optional)
//   <instanceId>/globals.<source_hash>.css   — instance globals (worker emits
//     `slug: "globals"` so the path is predictable; hash changes per build)
//   <instanceId>/providers.<source_hash>.js  — Step 5.3+5.4 providers bundle
//     (auto-emit from layout.tsx OR canvas.providers.tsx override; absent
//     when the worker detected no known providers)
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

/**
 * Locate and sign the current instance providers bundle (Step 5.3 + 5.4).
 *
 * Same listing-by-prefix pattern as signGlobalsCss: the worker uploads with
 * a hash-pinned key (`<instanceId>/providers.<hash>.js`) and overwrites on
 * every build; the freshest one by `updated_at DESC` is the active bundle.
 *
 * Returns null when the worker detected no known providers AND no
 * canvas.providers.tsx — the iframe bootstrap renders the customer component
 * bare (PR7 behavior, no regression).
 *
 * v1 known-risk (carry-forward from globals.css precedent): if a customer
 * once had providers (auto or override) and removes them, the stale bundle
 * stays in Storage and would still be picked up here. Document, don't fix in
 * v1.
 */
export async function signProvidersBundle(
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
    throw new Error(`signProvidersBundle list ${instanceId}: ${error.message}`)
  }
  const match = (data ?? []).find((f) => /^providers\.[a-f0-9]+\.js$/i.test(f.name))
  if (!match) return null
  return signStoragePath(`${instanceId}/${match.name}`)
}

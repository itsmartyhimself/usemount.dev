// Supabase Storage upload helpers for the build worker.
//
// Bucket = `component-artifacts` (provisioned by Step 4.2-prep; private,
// 50 MiB per object). Service-role bypasses Storage RLS — the read path
// (signed URLs from 4.3) is a separate later concern.
//
// Keys are idempotent: instance_id/slug.<source_hash>.<ext>. `upsert: true`
// overwrites the same key without error on retry, so a failed-mid-upload
// retry never accumulates duplicates.

import { supabaseAdmin } from "../supabase/admin.js"

const BUCKET = "component-artifacts"

export async function uploadJs(opts: {
  instanceId: string
  slug: string
  sourceHash: string
  bytes: Uint8Array
}): Promise<string> {
  const key = `${opts.instanceId}/${opts.slug}.${opts.sourceHash}.js`
  const { error } = await supabaseAdmin()
    .storage.from(BUCKET)
    .upload(key, opts.bytes, {
      contentType: "application/javascript",
      upsert: true,
    })
  if (error) throw new Error(`storage upload ${key}: ${error.message}`)
  return key
}

export async function uploadCss(opts: {
  instanceId: string
  slug: string
  sourceHash: string
  bytes: Uint8Array
}): Promise<string> {
  const key = `${opts.instanceId}/${opts.slug}.${opts.sourceHash}.css`
  const { error } = await supabaseAdmin()
    .storage.from(BUCKET)
    .upload(key, opts.bytes, {
      contentType: "text/css",
      upsert: true,
    })
  if (error) throw new Error(`storage upload ${key}: ${error.message}`)
  return key
}

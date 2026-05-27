// Iframe runtime host — Step 4.3 crown-jewel security surface.
//
// Returns an HTML document that:
//   1. Sets a strict CSP via response header (no `unsafe-inline` scripts;
//      nonce-protected importmap + bootstrap; `connect-src 'none'` blocks all
//      network exfil; `frame-ancestors 'self'` blocks parent-spoofing).
//   2. Inlines an importmap aliasing `react`/`react-dom`/`react-dom/client`/
//      `react/jsx-runtime` to the self-hosted ESM bundles in
//      /preview-runtime/ (apps/web/public/preview-runtime/, built by
//      apps/api/scripts/build-preview-runtime.ts). PR6's bundle externalizes
//      React; the iframe MUST supply it.
//   3. Dynamic-imports the customer bundle from a 15-min signed Storage URL,
//      picks the component via a heuristic (default export → first PascalCase
//      function export; see security-notes), and mounts it into #root.
//   4. Exchanges typed postMessages with the host canvas
//      (packages/shared/src/iframe-protocol.ts).
//
// The iframe element on the host side sets `sandbox="allow-scripts"` with
// NO `allow-same-origin` — opaque origin, no access to host cookies/storage.
// `event.origin === 'null'` (string) on the host side; the host validates
// `event.source === iframe.contentWindow` instead.
//
// D1 = same-origin v1 (route lives on the dashboard host); R9 coordinated
// cutover lifts to a `preview.usemount.dev` subdomain for cross-origin
// defense-in-depth.

import { randomBytes } from "node:crypto"
import { NextResponse, type NextRequest } from "next/server"
import {
  type BuildManifestKind,
  IFRAME_PROTOCOL_VERSION,
} from "@usemount/shared"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import {
  SIGNED_URL_TTL_SECONDS,
  signGlobalsCss,
  signProvidersBundle,
  signStoragePath,
} from "@/lib/storage/signed-url"
import {
  buildCsp,
  renderErrorHtml,
  renderIframeHtml,
} from "@/lib/preview/iframe-html"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface ManifestRow {
  id: string
  instance_id: string
  slug: string
  title: string | null
  kind: BuildManifestKind | null
  artifact_url: string | null
  preview_artifact_url: string | null
  source_hash: string | null
}

export async function GET(
  _request: NextRequest,
  ctx: { params: Promise<{ manifestId: string }> },
): Promise<Response> {
  const { manifestId } = await ctx.params
  if (!UUID_RE.test(manifestId)) {
    return errorResponse("invalid manifest id", 400)
  }

  // RLS gate: a non-member of the workspace gets `null` here even with a
  // valid uuid, so a leaked uuid alone doesn't grant preview access.
  const supabase = await createSupabaseServerClient()
  const { data: row, error } = await supabase
    .from("component_manifests")
    .select(
      "id, instance_id, slug, title, kind, artifact_url, preview_artifact_url, source_hash",
    )
    .eq("id", manifestId)
    .maybeSingle<ManifestRow>()
  if (error) return errorResponse(`lookup failed: ${error.message}`, 500)
  if (!row) return errorResponse("manifest not found", 404)

  if (row.kind !== "component") {
    return errorResponse(
      row.kind === "maybe-rsc"
        ? "Server component — not supported in v1."
        : "This component is marked unsupported and can't be previewed.",
      422,
    )
  }
  if (!row.artifact_url) {
    return errorResponse(
      "Build did not produce a bundle for this component.",
      422,
    )
  }

  let bundleUrl: string
  let perComponentCssUrl: string | null = null
  let perPreviewCssUrl: string | null = null
  let globalsCssUrl: string | null = null
  let providersUrl: string | null = null
  let previewUrl: string | null = null
  try {
    bundleUrl = await signStoragePath(row.artifact_url)
    // PR19 — optional preview-example bundle. Signed like the component bundle;
    // the iframe renders its default export instead of the bare component.
    if (row.preview_artifact_url) {
      try {
        previewUrl = await signStoragePath(row.preview_artifact_url)
      } catch {
        previewUrl = null
      }
      // PR22 — the example's own CSS sits at the .css sibling of the preview
      // JS key (no DB column). Sign-if-exists: old bundles 404 → null.
      const previewCssKey = row.preview_artifact_url.replace(/\.js$/, ".css")
      try {
        perPreviewCssUrl = await signStoragePath(previewCssKey)
      } catch {
        perPreviewCssUrl = null
      }
    }
    if (row.source_hash) {
      const cssKey = row.artifact_url.replace(/\.js$/, ".css")
      try {
        perComponentCssUrl = await signStoragePath(cssKey)
      } catch {
        perComponentCssUrl = null
      }
    }
    globalsCssUrl = await signGlobalsCss(row.instance_id)
    // Step 5.3 + 5.4 — providers bundle is optional; null when the worker
    // detected no known providers AND no canvas.providers.tsx was supplied.
    providersUrl = await signProvidersBundle(row.instance_id)
  } catch (e) {
    return errorResponse(`storage signing failed: ${(e as Error).message}`, 500)
  }

  const nonce = randomBytes(16).toString("base64")
  const supabaseHost = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").host
  const html = renderIframeHtml({
    nonce,
    title: row.title ?? row.slug,
    bundleUrl,
    perComponentCssUrl,
    perPreviewCssUrl,
    globalsCssUrl,
    providersUrl,
    previewUrl,
    protocolVersion: IFRAME_PROTOCOL_VERSION,
  })
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": buildCsp(nonce, supabaseHost),
      "cache-control": `private, max-age=${SIGNED_URL_TTL_SECONDS - 60}`,
      "x-content-type-options": "nosniff",
      "x-frame-options": "SAMEORIGIN",
      "referrer-policy": "no-referrer",
    },
  })
}

function errorResponse(message: string, status: number): NextResponse {
  return new NextResponse(renderErrorHtml(message), {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self';",
      "x-content-type-options": "nosniff",
      // Defense-in-depth consistency with the success path above: the error
      // page has no iframe-able content, but mirroring the SAMEORIGIN header
      // keeps the surface uniform for future readers + scanners.
      "x-frame-options": "SAMEORIGIN",
    },
  })
}

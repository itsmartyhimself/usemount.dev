import type { NextRequest } from "next/server"

/**
 * The PUBLIC origin of the app, for building server-side redirect URLs.
 *
 * `new URL(request.url).origin` is the origin the Next.js server sees, which
 * behind a reverse proxy (Railway, etc.) is the INTERNAL bind — on Railway that
 * is `localhost:8080`, the container port. Redirecting to that origin sends the
 * browser to `https://localhost:8080/...` (connection refused). The real public
 * host arrives in the `x-forwarded-host` / `x-forwarded-proto` headers the edge
 * sets, so we reconstruct from those when present and fall back to the request
 * origin for local dev (no proxy, no forwarded headers).
 *
 * Trusting `x-forwarded-host` is safe here because Railway's edge is the only
 * ingress and overwrites it. (Hardening option for later: pin to an explicit
 * public-URL env var and use the header only as a fallback.)
 */
export function publicOrigin(request: NextRequest): string {
  // Multi-proxy chains comma-list these headers; take the first (client-facing)
  // value. Railway is a single edge, but the split is free insurance.
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim()
  if (forwardedHost) {
    const proto =
      request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? "https"
    return `${proto}://${forwardedHost}`
  }
  return new URL(request.url).origin
}

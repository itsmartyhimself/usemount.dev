import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { installRoutes } from "./github/install-callback.js"
import { repoConnectionRoutes } from "./github/connections.js"
import { instanceRoutes } from "./github/instances.js"
import { webhookRoutes } from "./github/webhook.js"

// Builds the configured Hono `app` with all routers mounted, identical to
// what src/index.ts serves. Extracted to its own module so verification scripts
// can `import { buildApp } from "../src/app.js"` and call `app.request(...)`
// without binding a port — the standard Hono test pattern. index.ts still owns
// env validation + serve().
//
// /health stays open intentionally; auth is per-route (bearer for the connect
// surface, HMAC for the webhook). No global auth middleware.
//
// CORS (R7/R9 deploy prep): WEB_ORIGIN locks the browser-callable connect
// surface to the dashboard's origin(s) (comma-separated allowed). Unset →
// permissive `cors()`, which keeps local dev AND the first Railway deploy
// working before the web URL is known. Once the dashboard URL exists, set
// WEB_ORIGIN to it and redeploy to lock down. The GitHub webhook is
// server-to-server (browsers never call it), so CORS doesn't gate it.
function corsMiddleware() {
  const webOrigin = process.env.WEB_ORIGIN?.trim()
  if (!webOrigin) {
    // Permissive is fine for local dev / the first deploy, but in production it
    // means any origin can call the connect surface — surface that loudly so a
    // public launch with WEB_ORIGIN unset is visible in the logs (0a finding).
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[cors] WEB_ORIGIN unset in production — CORS is permissive (any origin). Set WEB_ORIGIN to the dashboard URL to lock down.",
      )
    }
    return cors()
  }
  const origins = webOrigin
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
  return cors({ origin: origins })
}

export function buildApp() {
  const app = new Hono()
  app.use("*", logger())
  app.use("*", corsMiddleware())
  app.get("/health", (c) => c.json({ ok: true }))
  app.route("/", installRoutes)
  app.route("/", repoConnectionRoutes)
  app.route("/", instanceRoutes)
  app.route("/", webhookRoutes)
  return app
}

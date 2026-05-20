import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { installRoutes } from "./github/install-callback.js"
import { repoConnectionRoutes } from "./github/connections.js"
import { webhookRoutes } from "./github/webhook.js"

// Builds the configured Hono `app` with all routers mounted, identical to
// what src/index.ts serves. Extracted to its own module so verification scripts
// can `import { buildApp } from "../src/app.js"` and call `app.request(...)`
// without binding a port — the standard Hono test pattern. index.ts still owns
// env validation + serve().
//
// /health stays open intentionally; auth is per-route (bearer for the connect
// surface, HMAC for the webhook). No global auth middleware.

export function buildApp() {
  const app = new Hono()
  app.use("*", logger())
  app.use("*", cors())
  app.get("/health", (c) => c.json({ ok: true }))
  app.route("/", installRoutes)
  app.route("/", repoConnectionRoutes)
  app.route("/", webhookRoutes)
  return app
}

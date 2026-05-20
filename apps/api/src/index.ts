import { serve } from "@hono/node-server"
import { buildApp } from "./app.js"
import { startWorkerLoop } from "./build/worker.js"

// Local dev loads apps/api/.env.local. On Railway, env vars are injected into
// the process directly (no file), so loadEnvFile throws there and we fall back
// to the platform-provided environment.
try {
  process.loadEnvFile(".env.local")
} catch {
  // No .env.local — using platform-provided environment (Railway).
}

// Fail fast at boot if the api's env contract is unmet. apps/api does not
// consume these until Step 2/3, but enforcing the contract from Step 0 keeps a
// half-configured deploy from booting silently.
const REQUIRED_ENV = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GITHUB_APP_ID",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_WEBHOOK_SECRET",
  "GITHUB_APP_PRIVATE_KEY_BASE64",
] as const

const missing = REQUIRED_ENV.filter((k) => !process.env[k]?.trim())
if (missing.length > 0) {
  throw new Error(
    `[usemount/api] Missing required env vars: ${missing.join(", ")}. ` +
      `Copy apps/api/.env.example to apps/api/.env.local and fill them in ` +
      `(or set them as Railway service variables).`,
  )
}

const app = buildApp()
const port = Number(process.env.PORT) || 4000

const httpServer = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`usemount.dev API running on port ${info.port}`)
})

// Build worker runs alongside the HTTP server — it polls `build_jobs` via the
// 0003 lease RPC, processes one job at a time, heartbeats while running. Set
// DISABLE_BUILD_WORKER=1 in dev to run the API without it (e.g. when working
// on routes only, no real builds needed).
const workerEnabled = !process.env.DISABLE_BUILD_WORKER
const worker = workerEnabled ? startWorkerLoop() : null

// Single source of process lifecycle. On SIGTERM/SIGINT: stop accepting new
// leases, await the current job to finish (or natural loop exit if idle),
// then close the HTTP server. Railway's drain semantics rely on this.
const shutdown = async (sig: string) => {
  console.log(`[main] ${sig} — shutting down`)
  try {
    worker?.stop()
    if (worker) await worker.done
  } catch (e) {
    console.error(`[main] worker shutdown error: ${(e as Error).message}`)
  }
  try {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()))
  } catch (e) {
    console.error(`[main] httpServer.close error: ${(e as Error).message}`)
  }
  console.log("[main] shutdown complete")
  process.exit(0)
}
process.once("SIGTERM", () => {
  shutdown("SIGTERM").catch(() => process.exit(1))
})
process.once("SIGINT", () => {
  shutdown("SIGINT").catch(() => process.exit(1))
})

import { serve } from "@hono/node-server"
import { buildApp } from "./app.js"

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

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`usemount.dev API running on port ${info.port}`)
})

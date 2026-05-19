// Centralised, typed env access for apps/api. src/index.ts already fails fast
// at boot if any required key is missing (REQUIRED_ENV) — these accessors are
// the typed read path used by the helpers/routes, with the same clear errors
// rather than an opaque downstream throw. Real Node env (Railway service vars
// locally apps/api/.env.local) — nothing here is NEXT_PUBLIC.

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(
      `[usemount/api] Missing required env var ${name}. ` +
        `Copy apps/api/.env.example to apps/api/.env.local and fill it in ` +
        `(or set it as a Railway service variable).`,
    )
  }
  return value
}

export const SUPABASE_URL = (): string => required("SUPABASE_URL")
export const SUPABASE_SERVICE_ROLE_KEY = (): string =>
  required("SUPABASE_SERVICE_ROLE_KEY")

export const GITHUB_APP_ID = (): string => required("GITHUB_APP_ID")
export const GITHUB_APP_CLIENT_ID = (): string =>
  required("GITHUB_APP_CLIENT_ID")
export const GITHUB_APP_CLIENT_SECRET = (): string =>
  required("GITHUB_APP_CLIENT_SECRET")
export const GITHUB_APP_WEBHOOK_SECRET = (): string =>
  required("GITHUB_APP_WEBHOOK_SECRET")

// PEM private key, base64-encoded to a single line in env. Decoded here so the
// rest of the codebase only ever sees the usable PEM.
export const GITHUB_APP_PRIVATE_KEY = (): string =>
  Buffer.from(required("GITHUB_APP_PRIVATE_KEY_BASE64"), "base64").toString(
    "utf8",
  )

// Public GitHub App slug — used to build the install redirect. Non-secret;
// defaults to the registered app so the connect flow works without extra env.
export const GITHUB_APP_SLUG = (): string =>
  process.env.GITHUB_APP_SLUG?.trim() || "usemount-dev"

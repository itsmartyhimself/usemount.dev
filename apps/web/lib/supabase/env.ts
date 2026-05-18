// Centralised env access for the Supabase clients. Values are populated in
// apps/web/.env.local (gitignored) and as Railway service variables — see
// apps/web/.env.example. Fail fast with a clear message rather than letting
// Supabase throw an opaque error.
//
// IMPORTANT: each NEXT_PUBLIC_* reference below uses *literal* property access
// (`process.env.NEXT_PUBLIC_FOO`). Next/Turbopack only statically inlines the
// literal form into the browser bundle — dynamic access (`process.env[name]`)
// resolves to `undefined` client-side and would wrongly throw at first paint.

export const SUPABASE_URL = (): string => {
  const value = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!value) {
    throw new Error(
      "Missing required environment variable NEXT_PUBLIC_SUPABASE_URL. " +
        "Copy apps/web/.env.example to apps/web/.env.local and fill it in.",
    )
  }
  return value
}

export const SUPABASE_ANON_KEY = (): string => {
  const value = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!value) {
    throw new Error(
      "Missing required environment variable NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
        "Copy apps/web/.env.example to apps/web/.env.local and fill it in.",
    )
  }
  return value
}

// Server-only (admin client). Real Node env, never shipped to the browser.
export const SUPABASE_SERVICE_ROLE_KEY = (): string => {
  const value = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!value) {
    throw new Error(
      "Missing required environment variable SUPABASE_SERVICE_ROLE_KEY. " +
        "Copy apps/web/.env.example to apps/web/.env.local and fill it in.",
    )
  }
  return value
}

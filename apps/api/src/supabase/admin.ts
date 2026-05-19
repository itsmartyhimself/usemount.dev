import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } from "../env.js"

// Privileged, RLS-BYPASSING Supabase client for apps/api (service_role key).
// Mirror of apps/web/lib/supabase/admin.ts's lazy-factory shape: the client is
// created on first use, NOT at module load. Eager creation would read env
// during ESM import evaluation — before src/index.ts loads .env.local — and
// crash before the friendly REQUIRED_ENV boot check can report what's missing.
// Memoised so every route shares one client.
//
// Because RLS is bypassed, every route that uses this MUST enforce
// authorization in code (verify the bearer token, then check workspace
// membership) — the database is not the gate here, we are.
let client: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!client) {
    client = createClient(SUPABASE_URL(), SUPABASE_SERVICE_ROLE_KEY(), {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    })
  }
  return client
}

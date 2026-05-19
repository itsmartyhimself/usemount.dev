import { createBrowserClient } from "@supabase/ssr"
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./env"

// Browser (client component) Supabase client. Anon key + RLS enforced — every
// query runs as the signed-in user. Safe to call per-render; @supabase/ssr
// dedupes the underlying client and reads the session from cookies set by the
// proxy / auth callback.
export function createSupabaseBrowserClient() {
  return createBrowserClient(SUPABASE_URL(), SUPABASE_ANON_KEY())
}

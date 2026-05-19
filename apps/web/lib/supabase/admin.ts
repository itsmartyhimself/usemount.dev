import "server-only"
import { createClient } from "@supabase/supabase-js"
import { SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } from "./env"

// Privileged, RLS-BYPASSING Supabase client. service_role key — do not expose
// to the browser and never import this from ./server or any client component.
// `server-only` makes a client import a build error. Created now for Step 3
// (GitHub App backend / build worker) readiness; unused by PR2 read paths.
export function createSupabaseAdminClient() {
  return createClient(SUPABASE_URL(), SUPABASE_SERVICE_ROLE_KEY(), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })
}

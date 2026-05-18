import { cookies } from "next/headers"
import { createServerClient } from "@supabase/ssr"
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./env"

// Server (RSC / route handler / server action) Supabase client. Anon key —
// RLS-enforced, runs as the signed-in user. NEVER pass the service-role key
// here: that silently disables RLS for every authenticated request. Use
// ./admin for the privileged client.
//
// cookies() is async in Next 16 (sync access removed). setAll throws when
// called during RSC render (cookies are read-only there); the proxy refreshes
// the session on every request, so swallowing that case is safe.
export async function createSupabaseServerClient() {
  const cookieStore = await cookies()

  return createServerClient(SUPABASE_URL(), SUPABASE_ANON_KEY(), {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options)
          }
        } catch {
          // Called from a Server Component — read-only cookie store. The proxy
          // handles session refresh, so this can be safely ignored.
        }
      },
    },
  })
}

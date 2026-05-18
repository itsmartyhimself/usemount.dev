import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/supabase/env"

// Next 16 renamed the `middleware` file convention to `proxy` (deprecated in
// v16.0.0 — see node_modules/next/dist/docs/.../proxy.md). Same NextRequest/
// NextResponse contract, Node.js runtime. This is the canonical @supabase/ssr
// session-refresh pattern: without it, server `getUser()` can't rotate an
// expired JWT and signed-in users silently drop their session.
//
// Do NOT insert logic between createServerClient and getUser().
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(SUPABASE_URL(), SUPABASE_ANON_KEY(), {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value)
        }
        response = NextResponse.next({ request })
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options)
        }
      },
    },
  })

  await supabase.auth.getUser()

  return response
}

export const config = {
  matcher: [
    // Run on every path except Next internals and static assets.
    "/((?!_next/static|_next/image|favicon.ico|SVGs/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
}

import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/supabase/env"

// Next 16 renamed the `middleware` file convention to `proxy` (deprecated in
// v16.0.0 — see node_modules/next/dist/docs/.../proxy.md). Same NextRequest/
// NextResponse contract, Node.js runtime. It does two jobs: (1) the canonical
// @supabase/ssr session refresh — without it server `getUser()` can't rotate an
// expired JWT and signed-in users silently drop their session — and (2) an
// optimistic auth gate that sends signed-out visitors to /login. The gate is
// UX only; RLS in the data layer stays the real authorization boundary.
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

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl
  // Public paths: the login screen itself, the OAuth return (must pass for a
  // signed-out user mid-sign-in, or the callback can't complete its exchange),
  // and the sandboxed preview iframe (signed-URL gated on its own).
  const isPublic =
    pathname === "/login" ||
    pathname.startsWith("/auth") ||
    pathname.startsWith("/preview")

  // Signed-out visitor on a protected route → login screen.
  if (!user && !isPublic) {
    return redirectKeepingSession(request, "/login", response)
  }
  // Signed-in visitor shouldn't sit on the login screen → dashboard.
  if (user && pathname === "/login") {
    return redirectKeepingSession(request, "/", response)
  }

  return response
}

// Redirect while carrying over any session cookies the refresh just set on
// `from`, so a rotated token isn't dropped on the way to the new path.
function redirectKeepingSession(
  request: NextRequest,
  to: string,
  from: NextResponse,
) {
  const url = request.nextUrl.clone()
  url.pathname = to
  const redirect = NextResponse.redirect(url)
  for (const cookie of from.cookies.getAll()) {
    redirect.cookies.set(cookie)
  }
  return redirect
}

export const config = {
  matcher: [
    // Run on every path except Next internals and static assets.
    // `preview-runtime` is excluded like `_next/static`: the sandboxed preview
    // iframe (opaque origin, no cookies) fetches the React runtime bundles from
    // here, and running the auth gate would 307 them to /login. They're public
    // static assets, CORS-enabled in next.config.ts.
    "/((?!_next/static|_next/image|preview-runtime|favicon.ico|SVGs/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
}

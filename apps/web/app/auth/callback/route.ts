import { NextResponse, type NextRequest } from "next/server"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { publicOrigin } from "@/lib/http/public-origin"

// OAuth (PKCE) callback. Supabase redirects here with `?code=...`; we exchange
// it for a session (cookies written via the server client) and bounce to the
// originating path. `next` is sanitised to a same-origin absolute path so it
// can't be turned into an open redirect.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  // PUBLIC origin (not request.url's origin = Railway's internal localhost:8080).
  const origin = publicOrigin(request)
  const code = searchParams.get("code")
  const nextParam = searchParams.get("next") ?? "/"
  const next =
    nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/"

  if (code) {
    const supabase = await createSupabaseServerClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`)
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`)
}

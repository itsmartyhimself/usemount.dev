import { NextResponse, type NextRequest } from "next/server"

// GitHub App post-install Setup URL target. GitHub redirects the browser here
// with ?installation_id=&setup_action=&state=. This handler only sanitises and
// bounces back to /connect (same-origin); the authenticated ConnectRepoForm
// then exchanges {installation_id, state} at apps/api with the user's bearer
// token. Keeping a stable callback path (vs. pointing the Setup URL straight
// at /connect) lets the contract harden later without a GitHub App reconfig.
//
// Setup URL is not yet registered on the GitHub App (R9, deferred to the
// custom-domain coordinated pass) — value: <web-origin>/connect/callback.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const installationId = searchParams.get("installation_id")
  const setupAction = searchParams.get("setup_action")
  const state = searchParams.get("state") ?? ""

  const idOk = installationId && /^\d+$/.test(installationId)
  const actionOk = setupAction === "install" || setupAction === "update"

  if (!idOk || !actionOk) {
    return NextResponse.redirect(`${origin}/connect?connect_error=install`)
  }

  const next = new URL(`${origin}/connect`)
  next.searchParams.set("installation_id", installationId)
  if (state) next.searchParams.set("state", state)
  return NextResponse.redirect(next)
}

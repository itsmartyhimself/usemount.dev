import { HTTPException } from "hono/http-exception"
import { supabaseAdmin } from "../supabase/admin.js"
import { getAppOctokit } from "./auth.js"

// Prove the signed-in user actually controls this installation_id BEFORE any
// route reads its repos or writes a repo_connection from it. Without this a
// signed-in user who learns/guesses an installation_id could enumerate another
// account's repos (install-callback) or first-claim an unclaimed (install,repo)
// into their own workspace via /repo-connections — whose 409 only blocks
// RE-HOME of an already-existing row, never the first claim. Shared by BOTH
// routes deliberately; gating only install-callback is bypassable by a direct
// POST /repo-connections (PR4 audit finding, advisor-confirmed).
//
// v1 strategy = hard-deny Org/Enterprise (migration-plan PR4 decision C). For a
// personal-account install, installation.account.id IS the GitHub numeric user
// id — exactly the oauth_identities / users.github_user_id seam PR2's
// <correction> preserves — so User installs are fully verifiable with data
// apps/api already holds. Org/Enterprise installs have account.id = the org /
// enterprise id; proving the signed-in user administers that org needs a GitHub
// user-OAuth token apps/api does NOT have (the App installation token only
// carries contents/metadata/pull_requests:read; the sign-in OAuth App's
// provider_token is transient and unpersisted). Rather than guard the gap with
// infra the product owner cannot operate, v1 removes the surface entirely:
// Org/Enterprise installs are refused with a clear "not supported yet" error.
// The canonical upgrade — enable "Request user authorization (OAuth) during
// installation" on the GitHub App, exchange the post-install code, then
// GET /user/installations and compare — is the documented post-cutline
// follow-up (migration-log <next>), NOT a v1 dependency.

export interface InstallationAccount {
  id: number
  type: string
}

export async function assertInstallationOwnership(
  userId: string,
  installationId: number,
): Promise<InstallationAccount> {
  let acct:
    | { id?: number; type?: string }
    | null
    | undefined = null
  try {
    const { data: install } = await getAppOctokit().apps.getInstallation({
      installation_id: installationId,
    })
    acct = install.account
  } catch {
    // App-JWT or installation lookup failed — almost always a stale/removed
    // installation id.
    throw new HTTPException(404, { message: "Installation not found" })
  }
  if (!acct || typeof acct.id !== "number") {
    throw new HTTPException(404, { message: "Installation not found" })
  }

  // A GitHub App install account is a User, an Organization, or (no `type`
  // field) an Enterprise. Only User is verifiable in v1.
  if (!("type" in acct) || acct.type !== "User") {
    throw new HTTPException(403, {
      message:
        "Organization and Enterprise installs are not supported yet. " +
        "Install usemount.dev on a personal-account repository.",
    })
  }

  const { data: u } = await supabaseAdmin()
    .from("users")
    .select("github_user_id")
    .eq("id", userId)
    .maybeSingle()
  if (!u?.github_user_id || Number(acct.id) !== Number(u.github_user_id)) {
    throw new HTTPException(403, {
      message: "This installation belongs to a different GitHub account",
    })
  }

  return { id: acct.id, type: acct.type }
}

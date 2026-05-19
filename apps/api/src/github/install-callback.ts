import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import { GITHUB_APP_SLUG } from "../env.js"
import { requireUser } from "../lib/require-user.js"
import { signInstallState, verifyInstallState } from "../lib/state-token.js"
import { supabaseAdmin } from "../supabase/admin.js"
import { getAppOctokit, getInstallationOctokit } from "./auth.js"

// The connect-flow surface (file named per migration-plan's Critical files;
// it carries the three install/discovery routes — the repo_connection write +
// branch read live in ./connections.ts to keep mutation and discovery apart):
//   GET  /github/install-url     mint the signed install redirect
//   POST /github/install-callback  exchange a fresh installation_id → repos
//   GET  /github/installations   repos for the user's already-known installs
//
// User identity always comes from the verified bearer token (requireUser),
// never a path/body param — the literal migration-plan `:userId` shape was an
// IDOR and is intentionally dropped (PR3 deviation, advisor-confirmed).

export interface InstallRepo {
  key: string
  installationId: number
  githubRepoId: number
  orgRepo: string
  defaultBranch: string
  private: boolean
  alreadyConnected: boolean
}

// Live repos an installation can see. Installation token is minted fresh by
// Octokit's app-auth strategy (1h TTL, no caching for v1). per_page 100; >100
// repos in one install is a Step 4+ pagination concern.
async function listInstallRepos(
  installationId: number,
  connectedKeys: Set<string>,
): Promise<InstallRepo[]> {
  const octo = getInstallationOctokit(installationId)
  const { data } = await octo.apps.listReposAccessibleToInstallation({
    per_page: 100,
  })
  return data.repositories.map((r) => {
    const key = `${installationId}:${r.id}`
    return {
      key,
      installationId,
      githubRepoId: r.id,
      orgRepo: r.full_name,
      defaultBranch: r.default_branch,
      private: r.private,
      alreadyConnected: connectedKeys.has(key),
    }
  })
}

// repo_connections (install,repo) the user already has, across every workspace
// they belong to — used to flag rows as already-connected and to enumerate
// known installations. Service-role bypasses RLS so the workspace scoping is
// done explicitly here.
async function userConnections(userId: string) {
  const { data: memberships } = await supabaseAdmin()
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", userId)
  const workspaceIds = (memberships ?? []).map((m) => m.workspace_id)
  if (workspaceIds.length === 0) {
    return { workspaceIds, installIds: [] as number[], connectedKeys: new Set<string>() }
  }
  const { data: conns } = await supabaseAdmin()
    .from("repo_connections")
    .select("github_install_id,github_repo_id")
    .in("workspace_id", workspaceIds)
    .eq("active", true)
  const connectedKeys = new Set<string>()
  const installIds = new Set<number>()
  for (const c of conns ?? []) {
    connectedKeys.add(`${c.github_install_id}:${c.github_repo_id}`)
    installIds.add(Number(c.github_install_id))
  }
  return { workspaceIds, installIds: [...installIds], connectedKeys }
}

export const installRoutes = new Hono()

// CTA target. Returns the GitHub App install URL with a signed, user-bound,
// short-TTL state param so /connect/callback can prove the round-trip.
installRoutes.get("/github/install-url", async (c) => {
  const user = await requireUser(c)
  const state = signInstallState(user.id)
  const url = `https://github.com/apps/${GITHUB_APP_SLUG()}/installations/new?state=${encodeURIComponent(state)}`
  return c.json({ url })
})

// GitHub redirects the browser to the App Setup URL after install; apps/web's
// authenticated /connect/callback forwards { installationId, state } here with
// the user's bearer token. We verify the bearer AND that the state token was
// minted for this same user (defense in depth), then return the installable
// repos so the picker can render in the same response — no install_id needs
// persisting between callback and the final /repo-connections POST.
const callbackBody = z.object({
  installationId: z.coerce.number().int().positive(),
  state: z.string().min(1),
})
installRoutes.post("/github/install-callback", async (c) => {
  const user = await requireUser(c)
  const parsed = callbackBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    throw new HTTPException(400, { message: "Bad install-callback payload" })
  }
  const boundUserId = verifyInstallState(parsed.data.state)
  if (!boundUserId || boundUserId !== user.id) {
    throw new HTTPException(403, { message: "Invalid or expired install state" })
  }

  // Ownership: a valid (user-bound) state token does NOT prove this user owns
  // *this* installation_id — without this check any signed-in user could pass
  // an arbitrary installation_id and read another account's repos. For a
  // personal-account install, installation.account.id IS the GitHub numeric
  // user id — exactly the oauth_identities/users.github_user_id seam the
  // migration-plan + PR2 correction preserve. Org installs have account.id =
  // the ORG id (no per-user membership data in v1) → not checkable here;
  // tracked as a known risk for Step 4+.
  let installAccount: { id: number; type?: string } | null = null
  try {
    const { data: install } = await getAppOctokit().apps.getInstallation({
      installation_id: parsed.data.installationId,
    })
    if (install.account && "type" in install.account) {
      installAccount = { id: install.account.id, type: install.account.type }
    }
  } catch {
    throw new HTTPException(404, { message: "Installation not found" })
  }
  if (installAccount?.type === "User") {
    const { data: u } = await supabaseAdmin()
      .from("users")
      .select("github_user_id")
      .eq("id", user.id)
      .maybeSingle()
    if (
      !u?.github_user_id ||
      Number(installAccount.id) !== Number(u.github_user_id)
    ) {
      throw new HTTPException(403, {
        message: "This installation belongs to a different GitHub account",
      })
    }
  }

  const { connectedKeys } = await userConnections(user.id)
  let repos: InstallRepo[]
  try {
    repos = await listInstallRepos(parsed.data.installationId, connectedKeys)
  } catch {
    // The App JWT or installation lookup failed — almost always a stale/removed
    // installation. Surface as 502 so the UI can prompt a re-install.
    throw new HTTPException(502, {
      message: "Could not read this installation from GitHub",
    })
  }
  return c.json({ installationId: parsed.data.installationId, repos })
})

// Repos for installations the user already connected something from (the
// returning-user path). First-time users get [] here and the UI shows the
// Install-App CTA instead.
installRoutes.get("/github/installations", async (c) => {
  const user = await requireUser(c)
  const { installIds, connectedKeys } = await userConnections(user.id)
  const results = await Promise.all(
    installIds.map((id) =>
      listInstallRepos(id, connectedKeys).catch(() => [] as InstallRepo[]),
    ),
  )
  return c.json({ repos: results.flat() })
})

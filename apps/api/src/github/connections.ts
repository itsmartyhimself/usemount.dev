import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import {
  assertWorkspaceMember,
  assertWorkspaceOwner,
  requireUser,
} from "../lib/require-user.js"
import { supabaseAdmin } from "../supabase/admin.js"
import { getInstallationOctokit } from "./auth.js"
import { fetchRepoMeta } from "./fetch-package-json.js"
import { assertInstallationOwnership } from "./installation-ownership.js"
import { checkSupportMatrix } from "./support-matrix.js"

// repo_connection mutation + branch read. Split from install-callback.ts so
// the GitHub-discovery surface and the DB-write surface stay separate.
//   POST /repo-connections              create/reactivate + default-pin
//   GET  /repo-connections/:id/branches live branches ⊕ instance overlay
//
// repo_connections is owner-only to mutate (mirrors the SQL is_workspace_owner
// RLS policy; enforced here because service-role skips RLS). Branch read only
// needs membership.

export const repoConnectionRoutes = new Hono()

// Open Decision #4 (dashboard-build-plan): default-pin `main` (the repo's real
// default branch) plus anything matching the globs feat/* and release/*.
function isDefaultPinned(branchName: string, defaultBranch: string): boolean {
  return (
    branchName === defaultBranch ||
    branchName.startsWith("feat/") ||
    branchName.startsWith("release/")
  )
}

// DB build_status → the breadcrumb's BranchSyncStatus. The two enums differ:
// build_status has queued/running/canceled, BranchSyncStatus has `stale`.
// queued|running → syncing (PR3 "first sync hasn't run" → every fresh instance
// is queued). A live GitHub branch with no instance row → stale (known to
// GitHub, not synced/pinned) — the least-wrong existing token.
type BranchSyncStatus = "synced" | "syncing" | "failed" | "stale"
function toBranchSyncStatus(s: string | undefined): BranchSyncStatus {
  switch (s) {
    case "succeeded":
      return "synced"
    case "failed":
    case "canceled":
      return "failed"
    case "queued":
    case "running":
      return "syncing"
    default:
      return "stale"
  }
}

const createBody = z.object({
  workspaceId: z.string().uuid(),
  installationId: z.coerce.number().int().positive(),
  githubRepoId: z.coerce.number().int().positive(),
  orgRepo: z.string().regex(/^[^/]+\/[^/]+$/, "expected owner/repo"),
  defaultBranch: z.string().min(1),
})

repoConnectionRoutes.post("/repo-connections", async (c) => {
  const user = await requireUser(c)
  const parsed = createBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    throw new HTTPException(400, { message: "Bad repo-connection payload" })
  }
  const { workspaceId, installationId, githubRepoId, orgRepo, defaultBranch } =
    parsed.data

  await assertWorkspaceOwner(workspaceId, user.id)
  // Same gate as install-callback: prove the caller controls this
  // installation_id. install-callback is the UI path, but a direct POST here
  // with a guessed (installationId, githubRepoId) would otherwise first-claim
  // an unowned install (the 409 below only blocks RE-HOME of an existing row).
  await assertInstallationOwnership(user.id, installationId)

  const { data: ws, error: wsErr } = await supabaseAdmin()
    .from("workspaces")
    .select("name")
    .eq("id", workspaceId)
    .single()
  if (wsErr || !ws) {
    throw new HTTPException(404, { message: "Workspace not found" })
  }

  // The UNIQUE is (github_install_id, github_repo_id) — workspace_id is NOT
  // part of it, so a bare upsert would silently RE-HOME an existing connection
  // into the caller's workspace (cross-workspace claim). Refuse if this
  // (install,repo) already belongs to a different workspace; same-workspace
  // re-connect stays idempotent via the upsert below.
  const { data: existing } = await supabaseAdmin()
    .from("repo_connections")
    .select("workspace_id")
    .eq("github_install_id", installationId)
    .eq("github_repo_id", githubRepoId)
    .maybeSingle()
  if (existing && existing.workspace_id !== workspaceId) {
    throw new HTTPException(409, {
      message: "Repo is already connected to another workspace",
    })
  }

  // ── Connect-gate (Step 5.1, architecture-brief §17–73) ────────────────────
  // Refuse stacks outside the bounded support matrix BEFORE inserting the
  // repo_connections row. Reading package.json via the App's contents:read
  // permission is metadata-only — no customer code executes.
  // Two distinct failure modes:
  //   (a) matrix mismatch → 422 + structured violations (renderable inline)
  //   (b) Octokit/network error → 502 generic "try again" (transient)
  // The 422 path is what makes the architecture-brief promise honest;
  // without it, Tailwind-v3 / Next-15 / React-17 / TS-4 customers hit a
  // half-broken preview that looks like our bug.
  {
    const [owner, repo] = orgRepo.split("/")
    let meta
    try {
      const octo = getInstallationOctokit(installationId)
      meta = await fetchRepoMeta(octo, owner, repo, defaultBranch)
    } catch {
      throw new HTTPException(502, {
        message:
          "Couldn't verify support — GitHub didn't respond. Try again.",
      })
    }
    const violations = checkSupportMatrix({
      packageJson: meta.packageJson,
      lockfileName: meta.lockfileName,
    })
    if (violations.length > 0) {
      return c.json({ kind: "unsupported" as const, violations }, 422)
    }
  }

  // UNIQUE(github_install_id, github_repo_id): a repo previously disconnected
  // (active=false) in THIS workspace is re-activated by the upsert.
  const { data: conn, error: connErr } = await supabaseAdmin()
    .from("repo_connections")
    .upsert(
      {
        workspace_id: workspaceId,
        github_install_id: installationId,
        github_repo_id: githubRepoId,
        org_repo: orgRepo,
        default_branch: defaultBranch,
        active: true,
      },
      { onConflict: "github_install_id,github_repo_id" },
    )
    .select("id")
    .single()
  if (connErr || !conn) {
    throw new HTTPException(500, { message: "Could not save the connection" })
  }

  // Default-pin: create instance rows (build_status defaults to 'queued' — the
  // build worker is Step 4). Always pin the default branch even if live-branch
  // enumeration fails, so the dashboard always has at least one instance row.
  const pinned = new Map<string, true>([[defaultBranch, true]])
  try {
    const [owner, repo] = orgRepo.split("/")
    const octo = getInstallationOctokit(installationId)
    const { data: branches } = await octo.repos.listBranches({
      owner,
      repo,
      per_page: 100,
    })
    for (const b of branches) {
      if (isDefaultPinned(b.name, defaultBranch)) pinned.set(b.name, true)
    }
  } catch {
    // Branch enumeration failed — proceed with just the default branch pinned.
  }
  const instanceRows = [...pinned.keys()].map((branch) => ({
    workspace_id: workspaceId,
    repo_connection_id: conn.id,
    branch,
    pinned: true,
  }))
  const { error: instErr } = await supabaseAdmin()
    .from("instances")
    .upsert(instanceRows, { onConflict: "repo_connection_id,branch" })
  if (instErr) {
    throw new HTTPException(500, { message: "Could not create instances" })
  }

  // Mirror the dashboard's existing URL scheme exactly (repo-row.tsx):
  // /<workspace name lower>/<repo half of org/repo>/<branch>.
  const redirect = `/${ws.name.toLowerCase()}/${orgRepo.split("/")[1]}/${defaultBranch}`
  return c.json({ repoConnectionId: conn.id, redirect })
})

repoConnectionRoutes.get("/repo-connections/:id/branches", async (c) => {
  const user = await requireUser(c)
  const id = c.req.param("id")

  const { data: conn, error: connErr } = await supabaseAdmin()
    .from("repo_connections")
    .select("id,workspace_id,github_install_id,org_repo,default_branch,active")
    .eq("id", id)
    .single()
  if (connErr || !conn) {
    throw new HTTPException(404, { message: "Connection not found" })
  }
  await assertWorkspaceMember(conn.workspace_id, user.id)

  // Instance overlay: pinned flag + sync status/time per branch we track.
  const { data: instances } = await supabaseAdmin()
    .from("instances")
    .select("branch,pinned,build_status,last_synced_at")
    .eq("repo_connection_id", conn.id)
  const byBranch = new Map(
    (instances ?? []).map((i) => [i.branch, i] as const),
  )

  let liveNames: string[] = []
  if (conn.active) {
    try {
      const [owner, repo] = conn.org_repo.split("/")
      const octo = getInstallationOctokit(Number(conn.github_install_id))
      const { data: branches } = await octo.repos.listBranches({
        owner,
        repo,
        per_page: 100,
      })
      liveNames = branches.map((b) => b.name)
    } catch {
      // Fall back to tracked instances only if GitHub is unreachable.
    }
  }

  // Union of live GitHub branches and tracked instances, so a pinned branch
  // still shows even if GitHub enumeration is degraded.
  const names = new Set<string>([...liveNames, ...byBranch.keys()])
  const branches = [...names].map((name) => {
    const inst = byBranch.get(name)
    return {
      id: name,
      name,
      pinned: inst?.pinned ?? false,
      status: toBranchSyncStatus(inst?.build_status),
      lastSyncedAt: inst?.last_synced_at ?? null,
    }
  })

  return c.json({ defaultBranch: conn.default_branch, branches })
})

import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import {
  assertWorkspaceMember,
  assertWorkspaceOwner,
  requireUser,
} from "../lib/require-user.js"
import { tryConsume } from "../lib/rate-limit.js"
import { supabaseAdmin } from "../supabase/admin.js"
import { getInstallationOctokit } from "./auth.js"

// PR19 — the in-app folder/component picker (per-instance scan-scope override).
//   GET   /instances/:id/repo-tree      candidate component folders, live from
//                                       the GitHub git-tree (no clone/rebuild)
//   PATCH /instances/:id/preview-dirs   persist the override + enqueue a rebuild
//
// Mirrors connections.ts: requireUser (bearer) → workspace authz IN CODE
// (service-role bypasses RLS, so the DB is not the gate here). repo-tree only
// needs membership; preview-dirs is an instance mutation → owner-only, matching
// the instances_mod RLS policy in 0001_init.sql.

export const instanceRoutes = new Hono()

// Same skip set as the build worker's COMPONENT_SKIP (worker.ts) so the
// candidate counts shown in the picker equal what the build will actually
// produce. KEEP IN SYNC with worker.ts.
const SKIP =
  /\.(manifest|config|test|spec|stories|usemount|preview|d)\.(tsx?|ts)$|(^|\/)index\.tsx?$/
// mount.config.ts auto-detect fallback chain (mirrors mount-config.ts) — used
// only to DISPLAY the current default scan when there is no picker override.
const COMPONENTS_DIR_FALLBACKS = ["src/components", "components", "app/components"]

interface DirNode {
  // Repo-root-relative directory path (e.g. "components/plugin").
  path: string
  // Buildable .tsx directly in this dir (excludes skipped files).
  componentCount: number
  // Buildable .tsx anywhere beneath this dir (recursive) — picking a dir scans
  // it recursively, so this is what the user gets.
  totalCount: number
}

// Fold a recursive git-tree into the set of directories that contain buildable
// components, with direct + recursive counts. Repo root ("") is intentionally
// omitted — "preview the whole repo" is noise, the user picks named folders.
function buildDirNodes(
  entries: Array<{ path?: string; type?: string }>,
): DirNode[] {
  const direct = new Map<string, number>()
  const total = new Map<string, number>()
  for (const e of entries) {
    if (e.type !== "blob" || !e.path) continue
    const p = e.path
    if (!p.endsWith(".tsx")) continue
    const segs = p.split("/")
    if (segs.some((s) => s === "node_modules" || s.startsWith("."))) continue
    if (SKIP.test(p)) continue
    const dir = segs.slice(0, -1).join("/") // parent dir ("" = repo root)
    direct.set(dir, (direct.get(dir) ?? 0) + 1)
    // +1 to every ancestor dir (recursive count), skipping the "" root.
    const dirSegs = dir === "" ? [] : dir.split("/")
    let acc = ""
    for (const seg of dirSegs) {
      acc = acc === "" ? seg : `${acc}/${seg}`
      total.set(acc, (total.get(acc) ?? 0) + 1)
    }
  }
  const paths = new Set<string>([...direct.keys(), ...total.keys()])
  paths.delete("")
  const nodes: DirNode[] = []
  for (const path of paths) {
    nodes.push({
      path,
      componentCount: direct.get(path) ?? 0,
      totalCount: total.get(path) ?? 0,
    })
  }
  nodes.sort((a, b) => a.path.localeCompare(b.path))
  return nodes
}

// Display-only: what the build scans when there's no picker override — the
// mount.config.ts componentsDir, else the first existing fallback dir. NOT a
// security boundary (the worker does the real literal-only AST parse, and an
// override bypasses mount.config entirely), so a light regex read is fine.
async function resolveDefaultScan(
  octo: ReturnType<typeof getInstallationOctokit>,
  owner: string,
  repo: string,
  ref: string,
  dirs: DirNode[],
): Promise<string | null> {
  try {
    const { data } = await octo.repos.getContent({
      owner,
      repo,
      path: "mount.config.ts",
      ref,
    })
    if (!Array.isArray(data) && data.type === "file" && "content" in data) {
      const src = Buffer.from(data.content, "base64").toString("utf8")
      const m = src.match(/componentsDir\s*:\s*["'`]([^"'`]+)["'`]/)
      if (m) return m[1]
    }
  } catch {
    // no mount.config.ts (404) → fall through to the fallback chain
  }
  const dirSet = new Set(dirs.map((d) => d.path))
  for (const f of COMPONENTS_DIR_FALLBACKS) {
    if (dirSet.has(f)) return f
  }
  return null
}

instanceRoutes.get("/instances/:id/repo-tree", async (c) => {
  const user = await requireUser(c)
  const id = c.req.param("id")

  const { data: instance, error: instErr } = await supabaseAdmin()
    .from("instances")
    .select(
      "id, workspace_id, repo_connection_id, branch, last_synced_commit_sha, preview_dirs",
    )
    .eq("id", id)
    .maybeSingle()
  if (instErr || !instance) {
    throw new HTTPException(404, { message: "Instance not found" })
  }
  await assertWorkspaceMember(instance.workspace_id, user.id)

  const { data: conn, error: connErr } = await supabaseAdmin()
    .from("repo_connections")
    .select("github_install_id, org_repo")
    .eq("id", instance.repo_connection_id)
    .maybeSingle()
  if (connErr || !conn || !conn.org_repo) {
    throw new HTTPException(404, { message: "Connection not found" })
  }

  const [owner, repo] = conn.org_repo.split("/")
  const octo = getInstallationOctokit(Number(conn.github_install_id))

  let commitSha: string
  try {
    commitSha =
      instance.last_synced_commit_sha ??
      (await octo.repos.getBranch({ owner, repo, branch: instance.branch })).data
        .commit.sha
  } catch {
    throw new HTTPException(502, {
      message: "Couldn't reach GitHub to read the branch. Try again.",
    })
  }

  let dirs: DirNode[]
  let truncated = false
  try {
    const { data: tree } = await octo.git.getTree({
      owner,
      repo,
      tree_sha: commitSha,
      recursive: "true",
    })
    truncated = tree.truncated ?? false
    dirs = buildDirNodes(tree.tree)
  } catch {
    throw new HTTPException(502, {
      message: "Couldn't read the repo file tree from GitHub. Try again.",
    })
  }

  const defaultScan = await resolveDefaultScan(octo, owner, repo, commitSha, dirs)

  return c.json({
    commitSha,
    truncated,
    selectedDirs: Array.isArray(instance.preview_dirs)
      ? (instance.preview_dirs as string[])
      : null,
    defaultScan,
    dirs,
  })
})

// Clean repo-relative dir: no absolute path, no backslashes, no "."/".."/empty
// segments (defense in depth — the worker's resolveScanRoots also guards
// against traversal before scanning).
const safeRelDir = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (s) =>
      !s.startsWith("/") &&
      !s.includes("\\") &&
      !s.split("/").some((seg) => seg === ".." || seg === "." || seg === ""),
    "must be a clean repo-relative path",
  )

const previewDirsBody = z.object({
  dirs: z.array(safeRelDir).max(50).nullable(),
})

instanceRoutes.patch("/instances/:id/preview-dirs", async (c) => {
  const user = await requireUser(c)
  const id = c.req.param("id")
  const parsed = previewDirsBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    throw new HTTPException(400, { message: "Bad preview-dirs payload" })
  }

  const { data: instance, error: instErr } = await supabaseAdmin()
    .from("instances")
    .select("id, workspace_id, repo_connection_id, branch, last_synced_commit_sha")
    .eq("id", id)
    .maybeSingle()
  if (instErr || !instance) {
    throw new HTTPException(404, { message: "Instance not found" })
  }
  await assertWorkspaceOwner(instance.workspace_id, user.id)

  // Rate-limit BEFORE any GitHub/DB work (mirror push-enqueue) so a hostile
  // caller can't spin the build queue: 5 burst, refill 1 / 10s per instance.
  if (!tryConsume("rebuild", instance.id, { capacity: 5, refillPerSec: 0.1 })) {
    throw new HTTPException(429, {
      message: "Too many rebuilds — wait a moment and try again.",
    })
  }

  // Empty selection = clear the override (back to mount.config / auto-detect).
  const dirs =
    parsed.data.dirs && parsed.data.dirs.length > 0 ? parsed.data.dirs : null

  const { data: conn } = await supabaseAdmin()
    .from("repo_connections")
    .select("github_install_id, org_repo")
    .eq("id", instance.repo_connection_id)
    .maybeSingle()
  if (!conn || !conn.org_repo) {
    throw new HTTPException(404, { message: "Connection not found" })
  }

  // Rebuild at the last synced commit, else the branch HEAD. The worker
  // rebuilds ALL discovered components every job, so re-enqueueing at the same
  // sha correctly re-scans with the new dirs (no last_synced reset needed).
  let commitSha = instance.last_synced_commit_sha
  if (!commitSha) {
    try {
      const [owner, repo] = conn.org_repo.split("/")
      const octo = getInstallationOctokit(Number(conn.github_install_id))
      commitSha = (
        await octo.repos.getBranch({ owner, repo, branch: instance.branch })
      ).data.commit.sha
    } catch {
      throw new HTTPException(502, {
        message: "Couldn't reach GitHub to resolve the branch. Try again.",
      })
    }
  }

  // Persist the override + flip to 'queued' so the UI shows "rebuilding"
  // immediately (the worker sets 'succeeded'/'failed' when the job finishes).
  const { error: updErr } = await supabaseAdmin()
    .from("instances")
    .update({ preview_dirs: dirs, build_status: "queued" })
    .eq("id", instance.id)
  if (updErr) {
    throw new HTTPException(500, { message: "Could not save the selection" })
  }

  // Enqueue. 23505 on the active-dedup index = a build is already queued/
  // running at this sha → treat as success (it picks up the persisted dirs).
  const { data: job, error: jobErr } = await supabaseAdmin()
    .from("build_jobs")
    .insert({ instance_id: instance.id, commit_sha: commitSha })
    .select("id")
    .single()
  if (job?.id) {
    return c.json({ status: "queued" as const, previewDirs: dirs, commitSha })
  }
  if (jobErr && (jobErr as { code?: string }).code === "23505") {
    return c.json({ status: "deduped" as const, previewDirs: dirs, commitSha })
  }
  throw new HTTPException(500, { message: "Could not enqueue the rebuild" })
})

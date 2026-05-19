// Single source of truth for mapping Supabase rows → the locked dashboard
// shapes (@usemount/shared). Shared by state.tsx + the two hooks so the
// row→shape contract lives in one place. Internal helper, not a public API.
//
// NOTE (PR2): no repo_connections rows exist until Step 3 (GitHub App connect
// flow) lands, so these mappers don't render real data yet — they must
// typecheck and be correct-on-paper. The DB→UI status/primary derivations
// below are the PR2-agreed contract.
import type {
  Branch,
  RecentRepo,
  RepoConnection,
  RepoStatus,
  Workspace,
} from "@usemount/shared"

export type DbBuildStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"

export interface InstanceRow {
  id: string
  branch: string
  pinned: boolean
  last_synced_commit_sha: string | null
  last_synced_at: string | null
  build_status: DbBuildStatus
}

export interface RepoConnectionRow {
  id: string
  workspace_id: string
  org_repo: string | null
  default_branch: string
  connected_at: string
  instances: InstanceRow[] | null
}

export interface WorkspaceRow {
  id: string
  name: string
  kind: "personal" | "team"
}

function buildStatusToRepoStatus(status: DbBuildStatus): RepoStatus {
  switch (status) {
    case "succeeded":
      return "synced"
    case "failed":
    case "canceled":
      return "failed"
    case "queued":
    case "running":
    default:
      return "syncing"
  }
}

function toMs(iso: string | null): number {
  return iso ? Date.parse(iso) : 0
}

// kind==='team' is the only path that reads members[]; PR2's signup trigger
// only ever creates kind==='personal' workspaces, so [] is safe here.
export function mapWorkspace(row: WorkspaceRow): Workspace {
  return { id: row.id, name: row.name, kind: row.kind, members: [] }
}

export function mapRepoConnection(row: RepoConnectionRow): RepoConnection {
  const instances = row.instances ?? []
  const branches: Branch[] = instances.map((instance) => ({
    id: instance.id,
    name: instance.branch,
    repoId: row.id,
    sha: instance.last_synced_commit_sha ?? "",
    status: buildStatusToRepoStatus(instance.build_status),
    lastSyncedAtMs: toMs(instance.last_synced_at),
    pinned: instance.pinned,
    primary: instance.branch === row.default_branch,
  }))
  const primary = branches.find((b) => b.primary) ?? branches[0]
  const lastSyncedAtMs = branches.reduce(
    (max, b) => Math.max(max, b.lastSyncedAtMs),
    0,
  )
  return {
    id: row.id,
    orgRepo: row.org_repo ?? "",
    workspaceId: row.workspace_id,
    status: primary?.status ?? "synced",
    lastSyncedAtMs,
    primaryBranchId: primary?.id ?? "",
    branches,
    totalBranches: branches.length,
  }
}

export function toRecentRepo(repo: RepoConnection): RecentRepo {
  const primary = repo.branches.find((b) => b.primary) ?? repo.branches[0]
  return {
    repoId: repo.id,
    viewedAtMs: repo.lastSyncedAtMs,
    subtitle: `${primary?.name ?? "main"} · ${repo.totalBranches} branches`,
  }
}

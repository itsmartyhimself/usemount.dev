export type WorkspaceKind = "personal" | "team"

export interface Member {
  id: string
  name: string
  email: string
  avatarColor: string
  role: "owner" | "admin" | "member"
}

export interface Workspace {
  id: string
  name: string
  kind: WorkspaceKind
  members: Member[]
}

export type RepoStatus = "synced" | "syncing" | "failed" | "stale"

export interface Branch {
  id: string
  name: string
  repoId: string
  sha: string
  status: RepoStatus
  lastSyncedAtMs: number
  pinned: boolean
  primary?: boolean
}

export interface RepoConnection {
  id: string
  orgRepo: string
  workspaceId: string
  status: RepoStatus
  lastSyncedAtMs: number
  primaryBranchId: string
  branches: Branch[]
  totalBranches: number
}

export interface RecentRepo {
  repoId: string
  viewedAtMs: number
  highlight?: "dusk" | "twilight"
  subtitle?: string
}

export interface User {
  id: string
  name: string
  email: string
}

export type FilterKey = "all" | "personal" | string

export type SortKey = "lastSync" | "name"

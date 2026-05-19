import type {
  Branch,
  Member,
  RepoConnection,
  Workspace,
} from "./types"

// Staged demo data (D3): the dashboard read path (workspaces / repos / recent
// / user) is Supabase-sourced (PR2) and the connect flow is now real (PR3 —
// DEMO_AVAILABLE_REPOS / DEMO_INSTALLATIONS removed). What remains is consumed
// only by the still-mock dashboard/sidebar list (DEMO_REPOS, workspaceForRepo,
// synthesizeUnpinnedBranches + their deps) and dies with the registry rewire
// in Step 4.3. NOW stays internal — those helpers need it.
const NOW = Date.UTC(2026, 4, 11, 14, 0, 0)
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const acmeMembers: Member[] = [
  {
    id: "u-1",
    name: "Jules Bell",
    email: "jules@acme.co",
    avatarColor: "var(--color-text-primary)",
    role: "owner",
  },
  {
    id: "u-2",
    name: "Marin Park",
    email: "marin@acme.co",
    avatarColor: "var(--color-tag-info-ink)",
    role: "admin",
  },
  {
    id: "u-3",
    name: "Robin Lee",
    email: "robin@acme.co",
    avatarColor: "var(--color-tag-success-ink)",
    role: "member",
  },
]

export const PERSONAL_WORKSPACE: Workspace = {
  id: "ws-personal",
  name: "Personal",
  kind: "personal",
  members: [],
}

export const ACME_WORKSPACE: Workspace = {
  id: "ws-acme",
  name: "Acme",
  kind: "team",
  members: acmeMembers,
}

export const DEMO_WORKSPACES: Workspace[] = [
  PERSONAL_WORKSPACE,
  ACME_WORKSPACE,
]

function branch(b: Partial<Branch> & Pick<Branch, "id" | "name" | "repoId">): Branch {
  return {
    sha: "a1b2c3d",
    status: "synced",
    lastSyncedAtMs: NOW - 12 * MIN,
    pinned: true,
    ...b,
  }
}

export const DEMO_REPOS: RepoConnection[] = [
  {
    id: "r-1",
    orgRepo: "acme/components",
    workspaceId: ACME_WORKSPACE.id,
    status: "synced",
    lastSyncedAtMs: NOW - 12 * MIN,
    primaryBranchId: "r-1-main",
    totalBranches: 18,
    branches: [
      branch({
        id: "r-1-main",
        name: "main",
        repoId: "r-1",
        primary: true,
        sha: "a1b2c3d",
        lastSyncedAtMs: NOW - 12 * MIN,
      }),
      branch({
        id: "r-1-feat-cards",
        name: "feat/cards-v2",
        repoId: "r-1",
        sha: "9f8e7d6",
        lastSyncedAtMs: NOW - 3 * HOUR,
      }),
      branch({
        id: "r-1-release",
        name: "release/2026-05",
        repoId: "r-1",
        sha: "4d5e6f7",
        lastSyncedAtMs: NOW - 2 * DAY,
      }),
    ],
  },
  {
    id: "r-2",
    orgRepo: "acme/marketing-site",
    workspaceId: ACME_WORKSPACE.id,
    status: "syncing",
    lastSyncedAtMs: NOW - 45 * MIN,
    primaryBranchId: "r-2-main",
    totalBranches: 9,
    branches: [
      branch({
        id: "r-2-main",
        name: "main",
        repoId: "r-2",
        primary: true,
        status: "syncing",
        sha: "f1e2d3c",
        lastSyncedAtMs: NOW - 45 * MIN,
      }),
    ],
  },
  {
    id: "r-3",
    orgRepo: "jbell/lab-experiments",
    workspaceId: PERSONAL_WORKSPACE.id,
    status: "failed",
    lastSyncedAtMs: NOW - 6 * HOUR,
    primaryBranchId: "r-3-main",
    totalBranches: 4,
    branches: [
      branch({
        id: "r-3-main",
        name: "main",
        repoId: "r-3",
        primary: true,
        status: "failed",
        sha: "c0ffee1",
        lastSyncedAtMs: NOW - 6 * HOUR,
      }),
    ],
  },
  {
    id: "r-4",
    orgRepo: "acme/design-tokens",
    workspaceId: ACME_WORKSPACE.id,
    status: "stale",
    lastSyncedAtMs: NOW - 11 * DAY,
    primaryBranchId: "r-4-main",
    totalBranches: 6,
    branches: [
      branch({
        id: "r-4-main",
        name: "main",
        repoId: "r-4",
        primary: true,
        status: "stale",
        sha: "8a9b0c1",
        lastSyncedAtMs: NOW - 11 * DAY,
      }),
    ],
  },
  {
    id: "r-5",
    orgRepo: "jbell/portfolio",
    workspaceId: PERSONAL_WORKSPACE.id,
    status: "synced",
    lastSyncedAtMs: NOW - 2 * HOUR,
    primaryBranchId: "r-5-main",
    totalBranches: 3,
    branches: [
      branch({
        id: "r-5-main",
        name: "main",
        repoId: "r-5",
        primary: true,
        sha: "2bc4d5e",
        lastSyncedAtMs: NOW - 2 * HOUR,
      }),
    ],
  },
]

// TODO: ROADMAP §Dashboard — synthetic unpinned branches reveal client-side. Replace
// with the real branch enumeration query when GitHub App branches land.
const SYNTHETIC_TOPIC_NAMES = [
  "topic/inputs",
  "topic/avatar",
  "topic/data-table",
  "topic/sheet",
  "topic/tabs",
  "topic/nav",
  "topic/breadcrumb",
  "topic/menu",
  "topic/popover",
  "topic/tooltip",
  "topic/select",
  "topic/dialog",
  "topic/toast",
  "topic/calendar",
  "topic/skeleton",
]

const SYNTHETIC_SHA_POOL = [
  "8b2f1d3", "c4e2a17", "df3019a", "e6b0c92", "5a73be4",
  "2dc1f6a", "fa9b03e", "317c8e2", "94d6e1b", "6e8a2d9",
]

export function synthesizeUnpinnedBranches(
  repo: RepoConnection,
  count: number,
): Branch[] {
  return Array.from({ length: count }, (_unused, i) => ({
    id: `${repo.id}-unpinned-${i}`,
    name: SYNTHETIC_TOPIC_NAMES[i % SYNTHETIC_TOPIC_NAMES.length] + `-${i + 1}`,
    repoId: repo.id,
    sha: SYNTHETIC_SHA_POOL[i % SYNTHETIC_SHA_POOL.length],
    status: "synced" as const,
    lastSyncedAtMs: NOW - (i + 1) * HOUR,
    pinned: false,
  }))
}

export function workspaceForRepo(repoId: string): Workspace {
  const repo = DEMO_REPOS.find((r) => r.id === repoId)
  if (!repo) return PERSONAL_WORKSPACE
  return (
    DEMO_WORKSPACES.find((w) => w.id === repo.workspaceId) ?? PERSONAL_WORKSPACE
  )
}

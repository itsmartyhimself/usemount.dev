import type { Branch, RepoConnection } from "./types"

// The LAST mock in the dashboard read path: synthetic UNPINNED branches for the
// repo-row "other branches" expander reveal. Everything else — workspaces,
// repos, recent — is Supabase-sourced (PR2/PR3), and the mock workspace/repo
// data (DEMO_REPOS, DEMO_WORKSPACES, workspaceForRepo) was retired in PR20
// (recent-repos + the search modal now read real data). This helper stays only
// until real branch enumeration lands — see the TODO in dashboard-page.tsx +
// ROADMAP §Dashboard.
const NOW = Date.UTC(2026, 4, 11, 14, 0, 0)
const HOUR = 60 * 60_000

// TODO: ROADMAP §Dashboard — synthetic unpinned branches reveal client-side.
// Replace with the real branch enumeration query when GitHub App branches land.
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

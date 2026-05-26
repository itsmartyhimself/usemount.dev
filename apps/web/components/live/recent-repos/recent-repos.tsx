"use client"

import { RepoCard } from "@/components/live/repo-card"
import { useDashboardState } from "@/lib/dashboard/state"

export function RecentRepos() {
  const { recentRepos, repos, workspaces } = useDashboardState()

  if (recentRepos.length === 0) return null

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--spacing-3-5)",
        padding: "var(--spacing-1)",
        background: "var(--color-bg-tertiary)",
        borderRadius: "var(--radius-4-5)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "var(--spacing-3-5)",
        }}
      >
        <span
          className="type-4"
          style={{ color: "var(--color-text-tertiary)", lineHeight: 1 }}
        >
          Most accessed repos
        </span>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gap: "var(--spacing-1)",
        }}
      >
        {recentRepos.map((rr) => {
          // Real data from state (was DEMO_REPOS, which never matched the live
          // UUIDs → cards rendered blank). repos + workspaces come from the
          // same Supabase fetch as recentRepos.
          const repo = repos.find((r) => r.id === rr.repoId)
          if (!repo) return null
          const ws = workspaces.find((w) => w.id === repo.workspaceId)
          if (!ws) return null
          const primaryBranch =
            repo.branches.find((b) => b.primary)?.name ??
            repo.branches[0]?.name ??
            "main"
          return (
            <RepoCard
              key={rr.repoId}
              repo={repo}
              recent={rr}
              workspace={ws}
              primaryBranch={primaryBranch}
              subtitle={rr.subtitle}
            />
          )
        })}
      </div>
    </div>
  )
}

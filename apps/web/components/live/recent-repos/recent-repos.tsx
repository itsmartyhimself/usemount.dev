"use client"

import { RepoCard } from "@/components/live/repo-card"
import { useDashboardState } from "@/lib/dashboard/state"

export function RecentRepos() {
  const { recentRepos, repos, workspaces } = useDashboardState()

  // Resolve recents to renderable cards (skip any whose repo/workspace isn't in
  // state — repos + workspaces come from the same Supabase fetch as
  // recentRepos). Cap at 3: the row splits the parent evenly, so 1 card spans
  // full width, 2 go half-and-half, 3 go thirds.
  const cards = recentRepos
    .map((rr) => {
      const repo = repos.find((r) => r.id === rr.repoId)
      if (!repo) return null
      const ws = workspaces.find((w) => w.id === repo.workspaceId)
      if (!ws) return null
      const primaryBranch =
        repo.branches.find((b) => b.primary)?.name ??
        repo.branches[0]?.name ??
        "main"
      return { rr, repo, ws, primaryBranch }
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .slice(0, 3)

  if (cards.length === 0) return null

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
          gridTemplateColumns: `repeat(${cards.length}, minmax(0, 1fr))`,
          gap: "var(--spacing-1)",
        }}
      >
        {cards.map(({ rr, repo, ws, primaryBranch }) => (
          <RepoCard
            key={rr.repoId}
            repo={repo}
            recent={rr}
            workspace={ws}
            primaryBranch={primaryBranch}
            subtitle={rr.subtitle}
          />
        ))}
      </div>
    </div>
  )
}

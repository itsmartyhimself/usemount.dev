"use client"

import { type CSSProperties } from "react"
import { Command } from "cmdk"
import { RepoRow } from "@/components/live/repo-row"
import { useRecentRepos } from "@/lib/dashboard/use-recent-repos"
import type { RepoConnection, Workspace } from "@/lib/dashboard/types"

interface SearchModalDefaultProps {
  onSelect: (repo: RepoConnection) => void
  workspaces: Workspace[]
}

const containerStyle: CSSProperties = {
  padding: "var(--spacing-5)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--spacing-2)",
}

const headerStyle: CSSProperties = {
  paddingBlock: "var(--spacing-4)",
  paddingInline: "var(--spacing-6)",
  textAlign: "left",
  color: "var(--color-text-tertiary)",
}

export function SearchModalDefault({ onSelect, workspaces }: SearchModalDefaultProps) {
  const recent = useRecentRepos(3)

  return (
    <div style={containerStyle}>
      <div className="type-4" style={headerStyle}>
        Recently opened repos
      </div>
      {recent.map((repo) => (
        <Command.Item
          key={repo.id}
          asChild
          value={repo.id}
          onSelect={() => onSelect(repo)}
        >
          <RepoRow
            repo={repo}
            workspace={workspaces.find((w) => w.id === repo.workspaceId)}
            expanded={false}
            onToggleExpanded={() => {}}
            showChevron={false}
            showActions={false}
            showPin={false}
            showSyncingSpinner={false}
            showMeta={false}
            showStatusDot={false}
            interactive={false}
            className="hover:bg-[var(--color-bg-hover)] data-[selected=true]:bg-[var(--color-bg-hover)]"
          />
        </Command.Item>
      ))}
    </div>
  )
}

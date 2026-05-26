"use client"

import { type CSSProperties } from "react"
import { Command } from "cmdk"
import { RepoRow } from "@/components/live/repo-row"
import { Skeleton } from "@/components/imports/shadcn/skeleton"
import { useRepoSearch } from "@/lib/dashboard/use-repo-search"
import type { RepoConnection, Workspace } from "@/lib/dashboard/types"

interface SearchModalResultsProps {
  query: string
  onSelect: (repo: RepoConnection) => void
  workspaces: Workspace[]
}

const containerStyle: CSSProperties = {
  padding: "var(--spacing-5)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--spacing-2)",
}

const skeletonRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  height: 56,
  paddingBlock: "var(--spacing-5)",
  paddingInline: "var(--spacing-6)",
  gap: "var(--spacing-5)",
}

const skeletonMetaGroupStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--spacing-4)",
}

const emptyStyle: CSSProperties = {
  paddingBlock: "var(--spacing-9)",
  textAlign: "center",
  color: "var(--color-text-tertiary)",
}

const SKELETON_BG = "!bg-[var(--color-bg-tertiary)]"

export function SearchModalResults({
  query,
  onSelect,
  workspaces,
}: SearchModalResultsProps) {
  const { state, data } = useRepoSearch(query)

  // While the hold timer is still running we keep showing the skeleton — every
  // keystroke restarts the timer, so the skeleton stays mounted continuously
  // through a typing burst and only dismounts after the user has stopped for
  // SEARCH_HOLD_MS.
  if (state === "pending") {
    return (
      <div style={containerStyle}>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} style={skeletonRowStyle}>
            <Skeleton
              className={SKELETON_BG}
              style={{ width: 200, height: 16, borderRadius: "var(--radius-1)" }}
            />
            <div style={skeletonMetaGroupStyle}>
              <Skeleton
                className={SKELETON_BG}
                style={{ width: 100, height: 14, borderRadius: "var(--radius-1)" }}
              />
              <Skeleton
                className={SKELETON_BG}
                style={{ width: 80, height: 24, borderRadius: "var(--radius-3)" }}
              />
            </div>
          </div>
        ))}
      </div>
    )
  }

  // Defensive backstop for the real Supabase path; unreachable in demo mode
  // since the hook only emits empty data when the query itself is empty, and
  // the parent splits on that case to render <Default /> instead.
  if (data.length === 0) {
    return (
      <div className="type-4" style={emptyStyle}>
        No matches
      </div>
    )
  }

  return (
    <div style={containerStyle}>
      {data.map((repo) => (
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

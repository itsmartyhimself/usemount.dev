"use client"

import * as React from "react"
import {
  forwardRef,
  type CSSProperties,
  type KeyboardEvent,
  type Ref,
} from "react"
import { useRouter } from "next/navigation"
import { motion } from "framer-motion"
import {
  ChevronRight,
  Pin,
  PinFilled,
  Renew,
  View,
} from "@carbon/icons-react"
import { IconButton } from "@/components/live/icon-button"
import { StatusDot } from "@/components/live/status-dot"
import { WorkspaceChip } from "@/components/live/workspace-chip"
import { ROW_SPRING } from "@/components/live/row/row.config"
import { formatRelativeTimeShort } from "@/lib/time/relative"
import { workspaceForRepo } from "@/lib/dashboard/demo"
import type { RepoConnection, RepoStatus, Workspace } from "@/lib/dashboard/types"

interface RepoRowProps {
  repo: RepoConnection
  // Real owning workspace, resolved by the dashboard caller from state. Drives
  // the "open repo" link's workspace segment + the WorkspaceChip. Optional: the
  // passive search-modal rows (no nav, chip only) render outside the dashboard
  // state provider and fall back to the demo lookup below. Once the demo module
  // is retired, the search modals should resolve + pass this too.
  workspace?: Workspace
  expanded: boolean
  // When another row in the list is the active surface (its parent repo is
  // open, or the OtherBranchesExpander inside it is open), this row recedes
  // to bg-secondary. The active surface itself stays bg-elevated.
  dimmed?: boolean
  pinned?: boolean
  onToggleExpanded: (id: string) => void
  // Visibility / interactivity overrides — defaults preserve dashboard behavior.
  // Set interactive=false in the search modal where the row is a passive card
  // and a parent (Command.Item) paints resting / hover / selected fill.
  showChevron?: boolean
  showActions?: boolean
  showPin?: boolean
  showSyncingSpinner?: boolean
  showMeta?: boolean
  showStatusDot?: boolean
  interactive?: boolean
}

const STATUS_DOT_TONE: Record<RepoStatus, { tone: "success" | "danger" | "neutral"; variant: "solid" | "hollow" }> = {
  synced: { tone: "success", variant: "solid" },
  syncing: { tone: "neutral", variant: "hollow" },
  failed: { tone: "danger", variant: "solid" },
  stale: { tone: "neutral", variant: "hollow" },
}

const STATUS_META: Record<RepoStatus, (relTime: string) => string> = {
  synced: (t) => `synced ${t} ago`,
  syncing: () => `syncing…`,
  failed: () => `build failed`,
  stale: (t) => `stale · ${t} ago`,
}

type RepoRowComponentProps = RepoRowProps &
  Omit<React.HTMLAttributes<HTMLDivElement>, keyof RepoRowProps>

function RepoRowBase(
  {
    repo,
    workspace: workspaceProp,
    expanded,
    dimmed = false,
    pinned = false,
    onToggleExpanded,
    showChevron = true,
    showActions = true,
    showPin = true,
    showSyncingSpinner = true,
    showMeta = true,
    showStatusDot = true,
    interactive = true,
    ...rest
  }: RepoRowComponentProps,
  ref: Ref<HTMLDivElement>,
) {
  const router = useRouter()
  // Prefer the real workspace passed by the dashboard; fall back to the demo
  // lookup for callers that don't provide one (passive search-modal rows).
  const workspace = workspaceProp ?? workspaceForRepo(repo.id)
  const primaryBranch =
    repo.branches.find((b) => b.primary)?.name ?? repo.branches[0]?.name ?? "main"

  const dotConfig = STATUS_DOT_TONE[repo.status]
  const pinnedCount = repo.branches.filter((b) => b.pinned).length
  const unpinnedCount = Math.max(0, repo.totalBranches - pinnedCount)
  const metaText = expanded
    ? `${pinnedCount} pinned · ${unpinnedCount} other`
    : STATUS_META[repo.status](
        formatRelativeTimeShort(new Date(repo.lastSyncedAtMs), new Date()),
      )
  const isFailed = repo.status === "failed"
  const isStale = repo.status === "stale"
  const isSyncing = repo.status === "syncing"

  const rowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--spacing-5)",
    height: 56,
    paddingBlock: "var(--spacing-5)",
    paddingInline: "var(--spacing-6)",
    borderRadius: "var(--radius-4)",
    border: 0,
    width: "100%",
    cursor: "pointer",
    transition: "background-color var(--duration-micro) ease",
  }
  if (interactive) {
    rowStyle.background = dimmed
      ? "var(--color-bg-secondary)"
      : "var(--color-bg-primary)"
  }

  const handleToggle = () => onToggleExpanded(repo.id)
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      handleToggle()
    }
  }

  const interactiveAttrs = interactive
    ? {
        role: "button" as const,
        tabIndex: 0,
        "data-row": "repo",
        "aria-label": `Expand ${repo.orgRepo}`,
        "aria-expanded": expanded,
      }
    : {}

  const interactiveHandlers = interactive
    ? { onClick: handleToggle, onKeyDown: handleKeyDown }
    : {}

  return (
    <div
      ref={ref}
      {...interactiveAttrs}
      style={rowStyle}
      {...rest}
      {...interactiveHandlers}
    >
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--spacing-4)",
          flex: 1,
          minWidth: 0,
        }}
      >
        {showChevron ? (
          <motion.span
            animate={{ rotate: expanded ? 90 : 0 }}
            transition={ROW_SPRING}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--color-text-tertiary)",
              flexShrink: 0,
            }}
          >
            <ChevronRight size={16} />
          </motion.span>
        ) : null}
        <span
          className="font-mono font-medium type-4"
          style={{
            color: isStale ? "var(--color-text-secondary)" : "var(--color-text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {repo.orgRepo}
        </span>
        {showPin && pinned ? (
          <PinFilled size={12} style={{ color: "var(--color-text-tertiary)", flexShrink: 0 }} />
        ) : null}
      </span>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--spacing-4)",
          flexShrink: 0,
        }}
      >
        {showActions ? (
          <div
            data-row-action="true"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--spacing-2)",
            }}
          >
            <IconButton
              ariaLabel={`Open ${repo.orgRepo}`}
              icon={<View size={16} />}
              size={24}
              bordered={false}
              onClick={() =>
                router.push(`/${workspace.name.toLowerCase()}/${repo.orgRepo.split("/")[1]}/${primaryBranch}`)
              }
            />
            <IconButton
              ariaLabel={`Re-sync ${repo.orgRepo}`}
              icon={<Renew size={16} />}
              size={24}
              bordered={false}
            />
            <IconButton
              ariaLabel={pinned ? `Unpin ${repo.orgRepo}` : `Pin ${repo.orgRepo}`}
              icon={pinned ? <PinFilled size={16} /> : <Pin size={16} />}
              size={24}
              bordered={false}
            />
          </div>
        ) : null}

        {showMeta ? (
          <span
            className="font-mono type-3"
            style={{
              color:
                expanded
                  ? "var(--color-text-secondary)"
                  : isFailed
                    ? "var(--color-tag-danger-ink)"
                    : isStale
                      ? "var(--color-text-tertiary)"
                      : "var(--color-text-secondary)",
              whiteSpace: "nowrap",
            }}
          >
            {metaText}
          </span>
        ) : null}
        {showStatusDot ? (
          <StatusDot tone={dotConfig.tone} variant={dotConfig.variant} size={8} ariaLabel={`Status: ${repo.status}`} />
        ) : null}
        {showSyncingSpinner && isSyncing ? (
          <span
            className="icon-spin"
            style={{
              display: "inline-flex",
              color: "var(--color-text-secondary)",
            }}
            aria-hidden
          >
            <Renew size={14} />
          </span>
        ) : null}
        <WorkspaceChip workspace={workspace} />
      </div>
    </div>
  )
}

export const RepoRow = forwardRef(RepoRowBase)
RepoRow.displayName = "RepoRow"

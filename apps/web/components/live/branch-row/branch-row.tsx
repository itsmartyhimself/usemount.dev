"use client"

import {
  forwardRef,
  type CSSProperties,
  type Ref,
} from "react"
import Link from "next/link"
import { Pin, PinFilled, Renew } from "@carbon/icons-react"
import { IconButton } from "@/components/live/icon-button"
import { StatusDot } from "@/components/live/status-dot"
import { formatRelativeTimeShort } from "@/lib/time/relative"
import { DEMO_REPOS, workspaceForRepo } from "@/lib/dashboard/demo"
import type { Branch, RepoStatus } from "@/lib/dashboard/types"

interface BranchRowProps {
  branch: Branch
  // When true, the row's bg never changes on hover. The trailing icon cluster
  // still appears on hover. Used by the OtherBranchesExpander reveal so a
  // single traveling pill carries the hover affordance instead of each row
  // painting its own.
  noHoverBackground?: boolean
  onHoverChange?: (hovered: boolean) => void
}

const DOT_BY_STATUS: Record<
  RepoStatus,
  { tone: "success" | "danger" | "neutral"; variant: "solid" | "hollow" }
> = {
  synced: { tone: "success", variant: "solid" },
  syncing: { tone: "neutral", variant: "hollow" },
  failed: { tone: "danger", variant: "solid" },
  stale: { tone: "neutral", variant: "hollow" },
}

function BranchRowBase(
  { branch, noHoverBackground = false, onHoverChange }: BranchRowProps,
  ref: Ref<HTMLDivElement>,
) {
  const workspace = workspaceForRepo(branch.repoId)
  const parentRepo = DEMO_REPOS.find((r) => r.id === branch.repoId)
  const repoName = parentRepo?.orgRepo.split("/")[1] ?? branch.repoId

  const dot = DOT_BY_STATUS[branch.status]
  const isStale = branch.status === "stale"
  const isFailed = branch.status === "failed"
  const isSyncing = branch.status === "syncing"
  const href = `/${workspace.name.toLowerCase()}/${repoName}/${branch.name}`

  const rowStyle: CSSProperties = {
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--spacing-4)",
    height: 48,
    paddingTop: "var(--spacing-4)",
    paddingBottom: "var(--spacing-4)",
    paddingRight: "var(--spacing-6)",
    paddingLeft: "var(--spacing-11)",
    borderRadius: "var(--radius-4)",
    background: noHoverBackground ? "transparent" : "var(--color-bg-secondary)",
    border: 0,
    zIndex: 1,
    cursor: "pointer",
  }

  // Stretched-link pattern: an absolutely-positioned <Link> spans the row
  // and captures clicks. Re-sync IconButton sits in normal flow with a
  // higher stacking context so its click doesn't bleed through to the link.
  // Keeps the row clickable without nesting <button> inside <a>.
  const stretchedLinkStyle: CSSProperties = {
    position: "absolute",
    inset: 0,
    borderRadius: "inherit",
    zIndex: 1,
  }

  const nameColor = isStale ? "var(--color-text-secondary)" : "var(--color-text-primary)"
  const metaColor = isStale ? "var(--color-text-tertiary)" : "var(--color-text-secondary)"
  const relTime = formatRelativeTimeShort(
    new Date(branch.lastSyncedAtMs),
    new Date(),
  )

  return (
    <div
      ref={ref}
      data-row={noHoverBackground ? "branch-naked" : "branch"}
      data-status={branch.status}
      style={rowStyle}
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
    >
      {!isSyncing ? (
        <Link
          href={href}
          aria-label={`Open ${branch.name}`}
          style={stretchedLinkStyle}
        />
      ) : null}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--spacing-4)",
          flex: 1,
          minWidth: 0,
        }}
      >
        {isStale ? (
          <Pin size={14} style={{ color: "var(--color-text-tertiary)", flexShrink: 0 }} />
        ) : branch.pinned ? (
          <PinFilled size={14} style={{ color: "var(--color-text-primary)", flexShrink: 0 }} />
        ) : (
          <Pin size={14} style={{ color: "var(--color-text-tertiary)", flexShrink: 0 }} />
        )}
        <StatusDot tone={dot.tone} variant={dot.variant} size={8} />
        <span
          className="font-mono type-4"
          style={{
            color: nameColor,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {branch.name}
        </span>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--spacing-4)",
          flexShrink: 0,
        }}
      >
        {isSyncing ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--spacing-3)",
            }}
          >
            <span
              className="icon-spin"
              style={{ display: "inline-flex", color: "var(--color-text-secondary)" }}
              aria-hidden
            >
              <Renew size={14} />
            </span>
            <span
              className="font-mono type-3"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Syncing…
            </span>
          </div>
        ) : (
          <>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: isFailed ? "var(--spacing-3)" : "var(--spacing-4)",
              }}
            >
              {isFailed ? (
                <>
                  <span
                    className="font-mono type-3 font-medium"
                    style={{ color: "var(--color-text-primary)" }}
                  >
                    Build failed
                  </span>
                  <span style={{ color: "var(--color-text-tertiary)" }} aria-hidden>
                    ·
                  </span>
                  <button
                    type="button"
                    className="type-3 font-medium"
                    style={{
                      color: "var(--color-tag-danger-ink)",
                      cursor: "pointer",
                      position: "relative",
                      zIndex: 3,
                    }}
                  >
                    View logs
                  </button>
                </>
              ) : (
                <>
                  <span
                    className="font-mono type-3"
                    style={{ color: metaColor }}
                  >
                    {branch.sha}
                  </span>
                  <span style={{ color: "var(--color-text-tertiary)" }} aria-hidden>
                    ·
                  </span>
                  <span
                    className="font-mono type-3"
                    style={{ color: metaColor }}
                  >
                    synced {relTime} ago
                  </span>
                </>
              )}
            </div>
            {!isFailed ? (
              <div
                data-row-action="true"
                style={{
                  position: "relative",
                  zIndex: 3,
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--spacing-2)",
                }}
              >
                <IconButton
                  ariaLabel={`Re-sync ${branch.name}`}
                  icon={<Renew size={14} />}
                  size={24}
                  bordered={false}
                />
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

export const BranchRow = forwardRef(BranchRowBase)
BranchRow.displayName = "BranchRow"

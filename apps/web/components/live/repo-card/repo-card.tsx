"use client"

import { type CSSProperties } from "react"
import Link from "next/link"
import { StatusDot } from "@/components/live/status-dot"
import { formatRelativeTimeShort } from "@/lib/time/relative"
import type { RecentRepo, RepoConnection, Workspace } from "@/lib/dashboard/types"

interface RepoCardProps {
  repo: RepoConnection
  recent: RecentRepo
  workspace: Workspace
  primaryBranch: string
  subtitle?: string
}

export function RepoCard({
  repo,
  recent,
  workspace,
  primaryBranch,
  subtitle,
}: RepoCardProps) {
  const isDusk = recent.highlight === "dusk"

  // Whole card is the navigation surface. The "Open Repo" trailing element is
  // styled as a button but rendered as a <span> — nesting <a> inside <a> is
  // invalid HTML, and clicking anywhere on the card already navigates.
  const containerStyle: CSSProperties = {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    gap: "var(--spacing-3-5)",
    height: 160,
    padding:
      "var(--spacing-5) var(--spacing-4) var(--spacing-4) var(--spacing-4)",
    borderRadius: "var(--radius-4)",
    background: isDusk ? "var(--gradient-dusk)" : "var(--color-bg-elevated)",
    color: isDusk ? "var(--color-bg-primary)" : "var(--color-text-primary)",
    textDecoration: "none",
    cursor: "pointer",
  }

  const titleColor = isDusk ? "var(--color-bg-primary)" : "var(--color-text-primary)"
  const metaColor = isDusk ? "rgba(255,255,255,0.7)" : "var(--color-text-secondary)"
  const buttonBg = isDusk ? "var(--color-bg-primary)" : "var(--color-text-primary)"
  const buttonFg = isDusk ? "var(--color-text-primary)" : "var(--color-bg-primary)"

  const subtitleText =
    subtitle ?? `${primaryBranch} · ${repo.totalBranches} branches`

  const relTime = formatRelativeTimeShort(
    new Date(recent.viewedAtMs),
    new Date(),
  )
  const href = `/${workspace.name.toLowerCase()}/${repo.orgRepo.split("/")[1]}/${primaryBranch}`

  return (
    <Link href={href} style={containerStyle}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--spacing-1)",
          minWidth: 0,
        }}
      >
        <span
          className="font-mono type-4 font-medium"
          style={{
            color: titleColor,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {repo.orgRepo}
        </span>
        <span
          className="font-mono type-3"
          style={{
            color: metaColor,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {subtitleText}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--spacing-3)",
        }}
      >
        <span
          className="font-mono type-3"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "var(--spacing-2-5)",
            color: metaColor,
          }}
        >
          <StatusDot tone="success" variant="solid" size={8} />
          synced {relTime} ago
        </span>
        <span
          className="type-3 font-medium"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            paddingBlock: "var(--spacing-2)",
            paddingInline: "var(--spacing-4)",
            borderRadius: "var(--radius-2)",
            background: buttonBg,
            color: buttonFg,
          }}
        >
          Open Repo
        </span>
      </div>
    </Link>
  )
}

"use client"

import { useMemo } from "react"
import { LayoutGroup, motion } from "framer-motion"
import { Button } from "@/components/live/button"
import { GithubMark } from "@/components/live/auth-button/github-mark"
import { ConnectRepoRow } from "@/components/live/connect-repo-row"
import { ROW_SPRING } from "@/components/live/row/row.config"
import type { InstallRepo } from "@/lib/api/client"

interface StepSelectRepoProps {
  repos: InstallRepo[]
  value: string | null
  loading: boolean
  onChange: (key: string) => void
  onInstall: () => void
}

const containerStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "var(--spacing-1)",
  padding: "var(--spacing-1)",
  background: "var(--color-bg-tertiary)",
  borderRadius: "var(--radius-4-5)",
}

export function StepSelectRepo({
  repos,
  value,
  loading,
  onChange,
  onInstall,
}: StepSelectRepoProps) {
  const sortedRepos = useMemo(
    () =>
      [...repos].sort((a, b) => {
        if (a.alreadyConnected === b.alreadyConnected) return 0
        return a.alreadyConnected ? -1 : 1
      }),
    [repos],
  )

  if (loading) {
    return (
      <div style={{ ...containerStyle, padding: "var(--spacing-6)" }}>
        <span
          className="type-3"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Loading your repositories…
        </span>
      </div>
    )
  }

  // No installations yet (or none accessible) — the App must be installed on
  // GitHub before any repo can appear. This is the first-time path.
  if (sortedRepos.length === 0) {
    return (
      <div
        style={{
          ...containerStyle,
          alignItems: "center",
          gap: "var(--spacing-5)",
          padding: "var(--spacing-9) var(--spacing-6)",
        }}
      >
        <span
          className="type-3"
          style={{
            color: "var(--color-text-tertiary)",
            textAlign: "center",
            lineHeight: 1.5,
          }}
        >
          Install the usemount.dev GitHub App on the repositories you want to
          preview, then come back here.
        </span>
        <Button
          variant="pop"
          size="small"
          form="label"
          label="Install GitHub App"
          icon={<GithubMark size={14} />}
          onClick={onInstall}
        />
      </div>
    )
  }

  return (
    <LayoutGroup id="connect-repo-rows">
      <div role="radiogroup" style={containerStyle}>
        {sortedRepos.map((repo) => {
          const selected = repo.key === value
          return (
            <ConnectRepoRow
              key={repo.key}
              label={repo.orgRepo}
              selected={selected}
              disabled={repo.alreadyConnected}
              onSelect={() => onChange(repo.key)}
              activeFill={
                selected ? (
                  <motion.div
                    layoutId="connect-repo-active-pill"
                    initial={false}
                    transition={ROW_SPRING}
                    style={{
                      position: "absolute",
                      inset: 0,
                      borderRadius: "var(--radius-4)",
                      background: "var(--color-bg-hover-elevated)",
                      zIndex: 1,
                    }}
                  />
                ) : null
              }
              rightContent={
                repo.alreadyConnected ? (
                  <span
                    className="type-3"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    already connected
                  </span>
                ) : null
              }
            />
          )
        })}
        <div style={{ padding: "var(--spacing-2) var(--spacing-3)" }}>
          <Button
            variant="text-link"
            size="small"
            form="label"
            label="Install on more repositories"
            onClick={onInstall}
          />
        </div>
      </div>
    </LayoutGroup>
  )
}

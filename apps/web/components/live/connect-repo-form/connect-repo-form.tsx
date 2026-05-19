"use client"

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/live/button"
import { GithubMark } from "@/components/live/auth-button/github-mark"
import { ConnectRepoCrumb } from "@/components/live/connect-repo-crumb"
import { ConnectRepoHeader } from "@/components/live/connect-repo-header"
import { createSupabaseBrowserClient } from "@/lib/supabase/client"
import { mapWorkspace, type WorkspaceRow } from "@/lib/dashboard/from-rows"
import type { Workspace } from "@/lib/dashboard/types"
import {
  ApiError,
  connectApi,
  type InstallRepo,
} from "@/lib/api/client"
import { StepSelectRepo } from "./step-select-repo"
import { StepAssignWorkspace } from "./step-assign-workspace"

export function ConnectRepoForm() {
  const router = useRouter()
  const [repos, setRepos] = useState<InstallRepo[]>([])
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [repoKey, setRepoKey] = useState<string | null>(null)
  const [workspaceId, setWorkspaceId] = useState<string>("")
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const supabase = createSupabaseBrowserClient()

    void (async () => {
      try {
        // Workspaces (RLS-scoped to the signed-in user) — same source as the
        // dashboard. A fresh user always has exactly one personal workspace
        // from the signup trigger; default the assignment to it.
        const wsPromise = supabase
          .from("workspaces")
          .select("id,name,kind")
          .then(({ data }) =>
            ((data as WorkspaceRow[]) ?? []).map(mapWorkspace),
          )

        // Returning from a GitHub App install? The callback route bounced the
        // installation_id + signed state here. Exchange it; otherwise list the
        // repos from installs this user already connected from.
        const params = new URLSearchParams(window.location.search)
        const installId = params.get("installation_id")
        const state = params.get("state")
        if (params.get("connect_error") === "install") {
          setError("GitHub App install was cancelled or failed. Try again.")
        }

        const reposPromise =
          installId && state
            ? connectApi
                .installCallback(Number(installId), state)
                .then((r) => r.repos)
            : connectApi.installations().then((r) => r.repos)

        const [ws, repoList] = await Promise.all([wsPromise, reposPromise])
        if (!active) return

        setWorkspaces(ws)
        setWorkspaceId(
          (ws.find((w) => w.kind === "personal") ?? ws[0])?.id ?? "",
        )
        setRepos(repoList)
        setRepoKey(repoList.find((r) => !r.alreadyConnected)?.key ?? null)

        if (installId) {
          // Drop the one-time install params so a refresh doesn't re-exchange.
          window.history.replaceState({}, "", "/connect")
        }
      } catch (e) {
        if (!active) return
        setError(
          e instanceof ApiError
            ? `Couldn't load your repos (${e.status}). ${e.message}`
            : "Couldn't reach the connect service.",
        )
      } finally {
        if (active) setLoading(false)
      }
    })()

    return () => {
      active = false
    }
  }, [])

  const handleInstall = useCallback(async () => {
    setError(null)
    try {
      const { url } = await connectApi.installUrl()
      window.location.href = url
    } catch {
      setError("Couldn't start the GitHub App install.")
    }
  }, [])

  const handleSubmit = useCallback(async () => {
    const repo = repos.find((r) => r.key === repoKey)
    if (!repo || !workspaceId || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const { redirect } = await connectApi.createConnection({
        workspaceId,
        installationId: repo.installationId,
        githubRepoId: repo.githubRepoId,
        orgRepo: repo.orgRepo,
        defaultBranch: repo.defaultBranch,
      })
      router.push(redirect)
    } catch (e) {
      setSubmitting(false)
      setError(
        e instanceof ApiError
          ? `Connect failed (${e.status}). ${e.message}`
          : "Connect failed. Try again.",
      )
    }
  }, [repos, repoKey, workspaceId, submitting, router])

  const canSubmit = !!repoKey && !!workspaceId && !submitting

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--spacing-7)",
      }}
    >
      <ConnectRepoCrumb />
      <ConnectRepoHeader />
      <StepSelectRepo
        repos={repos}
        value={repoKey}
        loading={loading}
        onChange={setRepoKey}
        onInstall={handleInstall}
      />
      <StepAssignWorkspace
        workspaces={workspaces}
        value={workspaceId}
        onChange={setWorkspaceId}
      />
      {error ? (
        <p
          className="type-3"
          role="alert"
          style={{ margin: 0, color: "var(--color-tag-danger-ink)" }}
        >
          {error}
        </p>
      ) : null}
      <ConnectRepoFooter
        canSubmit={canSubmit}
        submitting={submitting}
        onSubmit={handleSubmit}
      />
    </div>
  )
}

function ConnectRepoFooter({
  canSubmit,
  submitting,
  onSubmit,
}: {
  canSubmit: boolean
  submitting: boolean
  onSubmit: () => void
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "var(--spacing-5)",
      }}
    >
      <p
        className="type-3"
        style={{
          margin: 0,
          color: "var(--color-text-tertiary)",
          lineHeight: 1.4,
        }}
      >
        Organization repos require admin install on GitHub.
      </p>
      <div style={{ display: "flex", gap: "var(--spacing-3)" }}>
        <Button
          variant="ghost"
          size="small"
          form="label"
          label="Cancel"
          href="/"
          borderColor="var(--color-border-secondary)"
        />
        <Button
          variant="pop"
          size="small"
          form="label"
          label="Connect repo"
          icon={<GithubMark size={14} />}
          disabled={!canSubmit}
          loading={submitting}
          onClick={onSubmit}
        />
      </div>
    </div>
  )
}

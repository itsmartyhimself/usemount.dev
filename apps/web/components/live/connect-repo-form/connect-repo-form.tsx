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

// Wire shape of the 422 response from `POST /repo-connections` when the
// repo's stack falls outside the bounded support matrix (apps/api/src/github/
// support-matrix.ts). Mirrored manually rather than imported — apps/web does
// not consume apps/api types, only its JSON.
type UnsupportedResponse = {
  kind: "unsupported"
  violations: Array<{
    field: string
    required: string
    found: string | null
    reason: "too-old" | "absent" | "unparseable"
  }>
}

function isUnsupported(body: unknown): body is UnsupportedResponse {
  if (!body || typeof body !== "object") return false
  const b = body as { kind?: unknown; violations?: unknown }
  return b.kind === "unsupported" && Array.isArray(b.violations)
}

// D5 copy per migration-plan Step 5.1 §D5 — one line per violation.
function formatUnsupported(body: UnsupportedResponse): string {
  const lines = ["This repo isn't supported yet.", "", "usemount.dev requires:"]
  for (const v of body.violations) {
    const found =
      v.reason === "absent"
        ? "missing"
        : v.reason === "unparseable"
          ? `couldn't parse ${v.found ?? "?"}`
          : (v.found ?? "?")
    lines.push(`• ${v.required} (you have ${found})`)
  }
  return lines.join("\n")
}

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
      // The connect-gate (apps/api ...connect-gate at Step 5.1) returns 422
      // with a structured `{ kind: "unsupported", violations: [...] }` body
      // when a repo's stack falls outside the support matrix. We render the
      // violations inline via the existing alert — proper failure-screen UI
      // is a later design pass (user chose "simplest for now" at PR9 kickoff).
      if (e instanceof ApiError && e.status === 422 && isUnsupported(e.body)) {
        setError(formatUnsupported(e.body))
      } else if (e instanceof ApiError) {
        setError(`Connect failed (${e.status}). ${e.message}`)
      } else {
        setError("Connect failed. Try again.")
      }
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
          style={{
            margin: 0,
            color: "var(--color-tag-danger-ink)",
            // Lets the multi-line connect-gate violations message wrap.
            whiteSpace: "pre-line",
          }}
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

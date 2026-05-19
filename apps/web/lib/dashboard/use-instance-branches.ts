"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import { createSupabaseBrowserClient } from "@/lib/supabase/client"
import { connectApi } from "@/lib/api/client"
import { MOCK_INSTANCE } from "@/components/live/instance-breadcrumb/instance-breadcrumb.mocks"
import type {
  BranchSummary,
  InstanceBreadcrumbData,
} from "@/components/live/instance-breadcrumb/types"

// Replaces MOCK_INSTANCE in the sidebar breadcrumb. The route only carries
// slugs (workspace name lower / repo half / branch) — not keys — so resolving
// the repo_connection from them is intentionally best-effort (the URL scheme
// is non-unique; tracked as a PR3 known risk). The breadcrumb still renders
// trail + current branch from the slugs even if branch enumeration fails, so
// the AppShell never hard-fails on a missing/ambiguous match.
//
// NOTE: migration-plan/ROADMAP spec this as useInstanceBranches(repoId) under
// apps/web/hooks/. Both are stale (R8): PR2 made lib/dashboard/ the hooks home
// and the call site (sidebar-header-zone) only has slugs, never a repoId — so
// the hook resolves the id itself. Deviation recorded in the migration-log.

const str = (v: string | string[] | undefined): string =>
  Array.isArray(v) ? (v[0] ?? "") : (v ?? "")

interface ConnRow {
  id: string
  org_repo: string | null
  workspace_id: string
}
interface WsRow {
  id: string
  name: string
}

export function useInstanceBranches(): {
  data: InstanceBreadcrumbData
  loading: boolean
  onSwitchBranch: (branchId: string) => void
} {
  const params = useParams()
  const router = useRouter()
  const workspaceSlug = str(params.workspace)
  const repoSlug = str(params.repo)
  const branchSlug = str(params.branch)

  const onInstanceRoute = !!workspaceSlug && !!repoSlug && !!branchSlug

  const [branches, setBranches] = useState<BranchSummary[]>([])
  const [loading, setLoading] = useState(onInstanceRoute)

  useEffect(() => {
    if (!onInstanceRoute) return
    let active = true
    const supabase = createSupabaseBrowserClient()

    void (async () => {
      try {
        const [{ data: conns }, { data: wsRows }] = await Promise.all([
          supabase
            .from("repo_connections")
            .select("id,org_repo,workspace_id")
            .eq("active", true),
          supabase.from("workspaces").select("id,name"),
        ])
        const wsName = new Map(
          ((wsRows as WsRow[]) ?? []).map((w) => [w.id, w.name] as const),
        )
        const match = ((conns as ConnRow[]) ?? []).find(
          (c) =>
            (wsName.get(c.workspace_id) ?? "").toLowerCase() ===
              workspaceSlug.toLowerCase() &&
            (c.org_repo ?? "").split("/")[1] === repoSlug,
        )
        if (!match) return
        const { branches: apiBranches } = await connectApi.branches(match.id)
        if (!active) return
        setBranches(
          apiBranches.map((b) => ({
            id: b.id,
            name: b.name,
            pinned: b.pinned,
            status: b.status,
            lastSyncedAt: b.lastSyncedAt ? new Date(b.lastSyncedAt) : null,
          })),
        )
      } catch {
        // Leave branches empty — trail + current branch still render below.
      } finally {
        if (active) setLoading(false)
      }
    })()

    return () => {
      active = false
    }
  }, [onInstanceRoute, workspaceSlug, repoSlug])

  const data = useMemo<InstanceBreadcrumbData>(() => {
    // Non-instance routes (e.g. /playground mounts AppShell with no params):
    // keep the demo breadcrumb so that dev surface is visually unchanged. The
    // component tree itself stays mock until Step 4.3 — out of PR3 scope.
    if (!onInstanceRoute) return MOCK_INSTANCE
    return {
      trail: [
        { kind: "workspace", label: workspaceSlug },
        { kind: "repo", label: repoSlug },
      ],
      branch: { id: branchSlug, name: branchSlug },
      branches,
    }
  }, [onInstanceRoute, workspaceSlug, repoSlug, branchSlug, branches])

  const onSwitchBranch = useCallback(
    (branchId: string) => {
      if (!onInstanceRoute) return
      router.push(
        `/${workspaceSlug}/${repoSlug}/${encodeURIComponent(branchId)}`,
      )
    },
    [onInstanceRoute, router, workspaceSlug, repoSlug],
  )

  return { data, loading, onSwitchBranch }
}

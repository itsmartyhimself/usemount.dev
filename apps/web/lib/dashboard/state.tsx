"use client"

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import { createSupabaseBrowserClient } from "@/lib/supabase/client"
import {
  mapRepoConnection,
  mapWorkspace,
  toRecentRepo,
  type RepoConnectionRow,
  type WorkspaceRow,
} from "./from-rows"
import type {
  FilterKey,
  RecentRepo,
  RepoConnection,
  SortKey,
  Workspace,
} from "./types"

interface DashboardState {
  workspaces: Workspace[]
  repos: RepoConnection[]
  recentRepos: RecentRepo[]
  // false once the initial Supabase fetch settles. Additive — lets the page
  // distinguish "still loading" from a genuinely empty account.
  loading: boolean
  // Single-row expansion: only one RepoRow can be open at a time. Clicking a
  // different repo closes the previously-open one.
  expandedRepoId: string | null
  expandedExpanderIds: Set<string>
  filter: FilterKey
  sort: SortKey
  toggleExpanded: (id: string) => void
  toggleExpander: (id: string) => void
  setFilter: (filter: FilterKey) => void
  setSort: (sort: SortKey) => void
  filteredRepos: RepoConnection[]
}

const DashboardStateContext = createContext<DashboardState | null>(null)

export function DashboardStateProvider({
  children,
  initiallyExpandedRepoId = null,
}: {
  children: ReactNode
  initiallyExpandedRepoId?: string | null
}) {
  const [expandedRepoId, setExpandedRepoId] = useState<string | null>(
    initiallyExpandedRepoId,
  )
  const [expandedExpanderIds, setExpandedExpanders] = useState<Set<string>>(
    () => new Set(),
  )
  const [filter, setFilter] = useState<FilterKey>("all")
  const [sort, setSort] = useState<SortKey>("lastSync")

  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [repos, setRepos] = useState<RepoConnection[]>([])
  const [recentRepos, setRecentRepos] = useState<RecentRepo[]>([])
  // The signed-in user's personal workspace UUID, resolved from the signup
  // trigger's row — the `filter === "personal"` branch keys off this, not a
  // hardcoded id.
  const [personalWorkspaceId, setPersonalWorkspaceId] = useState<string | null>(
    null,
  )
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    const supabase = createSupabaseBrowserClient()

    void (async () => {
      try {
        const [{ data: wsRows }, { data: repoRows }] = await Promise.all([
          supabase.from("workspaces").select("id,name,kind"),
          supabase
            .from("repo_connections")
            .select(
              "id,workspace_id,org_repo,default_branch,connected_at,instances(id,branch,pinned,last_synced_commit_sha,last_synced_at,build_status)",
            )
            .eq("active", true),
        ])
        if (!active) return

        const mappedWorkspaces = ((wsRows as WorkspaceRow[]) ?? []).map(
          mapWorkspace,
        )
        const mappedRepos = ((repoRows as RepoConnectionRow[]) ?? []).map(
          mapRepoConnection,
        )
        const personal = ((wsRows as WorkspaceRow[]) ?? []).find(
          (w) => w.kind === "personal",
        )
        const recent = [...mappedRepos]
          .sort((a, b) => b.lastSyncedAtMs - a.lastSyncedAtMs)
          .slice(0, 3)
          .map(toRecentRepo)

        setWorkspaces(mappedWorkspaces)
        setRepos(mappedRepos)
        setRecentRepos(recent)
        setPersonalWorkspaceId(personal?.id ?? null)
      } finally {
        if (active) setLoading(false)
      }
    })()

    return () => {
      active = false
    }
  }, [])

  const toggleExpanded = (id: string) => {
    setExpandedRepoId((prev) => (prev === id ? null : id))
  }

  const toggleExpander = (id: string) => {
    setExpandedExpanders((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const filteredRepos = useMemo(() => {
    let list = repos
    if (filter === "personal") {
      list = list.filter((r) => r.workspaceId === personalWorkspaceId)
    } else if (filter !== "all") {
      list = list.filter((r) => r.workspaceId === filter)
    }
    const sorted = [...list].sort((a, b) => {
      if (sort === "name") return a.orgRepo.localeCompare(b.orgRepo)
      return b.lastSyncedAtMs - a.lastSyncedAtMs
    })
    return sorted
  }, [repos, filter, sort, personalWorkspaceId])

  const value: DashboardState = {
    workspaces,
    repos,
    recentRepos,
    loading,
    expandedRepoId,
    expandedExpanderIds,
    filter,
    sort,
    toggleExpanded,
    toggleExpander,
    setFilter,
    setSort,
    filteredRepos,
  }

  return (
    <DashboardStateContext.Provider value={value}>
      {children}
    </DashboardStateContext.Provider>
  )
}

export function useDashboardState(): DashboardState {
  const ctx = useContext(DashboardStateContext)
  if (!ctx) {
    throw new Error("useDashboardState must be used inside <DashboardStateProvider>")
  }
  return ctx
}

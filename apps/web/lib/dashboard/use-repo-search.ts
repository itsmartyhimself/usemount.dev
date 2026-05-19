"use client"

import { useEffect, useState } from "react"
import { createSupabaseBrowserClient } from "@/lib/supabase/client"
import {
  mapRepoConnection,
  type RepoConnectionRow,
} from "@/lib/dashboard/from-rows"
import type { RepoConnection } from "@/lib/dashboard/types"
import {
  SEARCH_HOLD_MS,
  SEARCH_MAX_ROWS,
} from "@/components/live/search-modal/search-modal.config"

export type RepoSearchState = "idle" | "pending" | "resolved"

interface RepoSearchResult {
  state: RepoSearchState
  data: RepoConnection[]
}

const SELECT =
  "id,workspace_id,org_repo,default_branch,connected_at,instances(id,branch,pinned,last_synced_commit_sha,last_synced_at,build_status)"

// Debounced server-side search over the user's connected repos (RLS-scoped),
// case-insensitive on org_repo, capped at SEARCH_MAX_ROWS. Empty query →
// idle/[]. State machine + signature preserved; resolves to [] until
// repo_connections exist (Step 3). Branch-hit + fuzzy matching land with the
// GitHub App backend.
export function useRepoSearch(query: string): RepoSearchResult {
  const [state, setState] = useState<RepoSearchState>("idle")
  const [data, setData] = useState<RepoConnection[]>([])

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length === 0) {
      setState("idle")
      setData([])
      return
    }
    setState("pending")
    let active = true
    const supabase = createSupabaseBrowserClient()
    const timer = setTimeout(() => {
      void (async () => {
        const { data: rows } = await supabase
          .from("repo_connections")
          .select(SELECT)
          .eq("active", true)
          .ilike("org_repo", `%${trimmed}%`)
          .limit(SEARCH_MAX_ROWS)
        if (!active) return
        setData(((rows as RepoConnectionRow[]) ?? []).map(mapRepoConnection))
        setState("resolved")
      })()
    }, SEARCH_HOLD_MS)

    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [query])

  return { state, data }
}

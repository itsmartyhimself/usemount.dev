"use client"

import { useEffect, useState } from "react"
import { createSupabaseBrowserClient } from "@/lib/supabase/client"
import {
  mapRepoConnection,
  type RepoConnectionRow,
} from "@/lib/dashboard/from-rows"
import type { RepoConnection } from "@/lib/dashboard/types"

const SELECT =
  "id,workspace_id,org_repo,default_branch,connected_at,instances(id,branch,pinned,last_synced_commit_sha,last_synced_at,build_status)"

// Most-recently-synced connected repos for the signed-in user (RLS-scoped to
// member workspaces). Signature unchanged: returns RepoConnection[]; resolves
// to [] until repo_connections exist (Step 3).
export function useRecentRepos(limit: number): RepoConnection[] {
  const [repos, setRepos] = useState<RepoConnection[]>([])

  useEffect(() => {
    let active = true
    const supabase = createSupabaseBrowserClient()

    void (async () => {
      const { data } = await supabase
        .from("repo_connections")
        .select(SELECT)
        .eq("active", true)
      if (!active) return
      const mapped = ((data as RepoConnectionRow[]) ?? [])
        .map(mapRepoConnection)
        .sort((a, b) => b.lastSyncedAtMs - a.lastSyncedAtMs)
        .slice(0, limit)
      setRepos(mapped)
    })()

    return () => {
      active = false
    }
  }, [limit])

  return repos
}

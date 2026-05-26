"use client"

import { useEffect, useState } from "react"
import { createSupabaseBrowserClient } from "@/lib/supabase/client"
import { mapWorkspace, type WorkspaceRow } from "@/lib/dashboard/from-rows"
import type { Workspace } from "@/lib/dashboard/types"

// The signed-in user's workspaces (RLS-scoped to membership). Mirrors
// useRecentRepos — the search modal lives OUTSIDE DashboardStateProvider, so it
// fetches its own copy to resolve a repo's owning workspace (the WorkspaceChip
// + the nav URL's workspace segment) without the retired demo lookup. Resolves
// to [] until the rows load.
export function useWorkspaces(): Workspace[] {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])

  useEffect(() => {
    let active = true
    const supabase = createSupabaseBrowserClient()

    void (async () => {
      const { data } = await supabase.from("workspaces").select("id,name,kind")
      if (!active) return
      setWorkspaces(((data as WorkspaceRow[]) ?? []).map(mapWorkspace))
    })()

    return () => {
      active = false
    }
  }, [])

  return workspaces
}

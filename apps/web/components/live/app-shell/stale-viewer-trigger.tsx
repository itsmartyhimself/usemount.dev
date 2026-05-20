"use client"

// PR8 (Step 4.4): the 30s setTimeout demo is replaced with a Supabase
// Realtime subscription on the instances row. When the build worker writes
// a new `last_synced_commit_sha` (success of a build_job for this instance),
// any tab currently viewing the instance sees a non-blocking
// "branch has an update" toast and can refresh.
//
// Architecture-brief §3 ("Stale viewer detection"): "Each instance page
// subscribes to a Supabase Realtime channel keyed on `instance_id`. On
// `last_synced_commit_sha` change, the page shows a non-blocking
// 'New version available — refresh' banner."
//
// Edge cases:
//   - No instance (legacy /playground mount): no subscribe; no toast.
//   - initialSha === null (instance never built): the FIRST build's new
//     non-null sha triggers the toast — desired UX ("your first sync just
//     completed; refresh to see it").
//   - Same sha re-emitted (a no-op UPDATE that doesn't move sha): skipped.
//   - Multiple updates in quick succession: each one re-fires the toast IF
//     the sha actually drifted from the captured initial. Most UX systems
//     would suppress duplicates within a window; v1 keeps it simple — the
//     toast UI itself replaces in place via sonner.

import { useEffect, useRef } from "react"
import { createSupabaseBrowserClient } from "@/lib/supabase/client"
import { useToast } from "@/components/live/toast"

export interface StaleViewerTriggerProps {
  /** From `instances.id`. If undefined, no subscription is created. */
  instanceId?: string
  /**
   * `instances.last_synced_commit_sha` at page-load time. Used as the
   * comparison baseline. `null`/`undefined` means "no successful build
   * yet"; the first sha will trigger the toast.
   */
  initialSha?: string | null
}

export function StaleViewerTrigger({
  instanceId,
  initialSha,
}: StaleViewerTriggerProps) {
  const { showToast } = useToast()
  // Hold the current sha in a ref so the channel handler always reads the
  // latest baseline (after a toast fires + the user opts to keep viewing
  // without refreshing, the next sha-change still triggers anew).
  const currentShaRef = useRef<string | null>(initialSha ?? null)

  useEffect(() => {
    if (!instanceId) return
    const supabase = createSupabaseBrowserClient()
    const channel = supabase
      .channel(`instance:${instanceId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "instances",
          filter: `id=eq.${instanceId}`,
        },
        (payload) => {
          const next = (payload.new as { last_synced_commit_sha?: string | null })
            ?.last_synced_commit_sha
          if (!next) return
          if (next === currentShaRef.current) return
          currentShaRef.current = next
          showToast({
            tone: "warning",
            title: "This branch has an update",
            action: {
              label: "Refresh",
              onClick: () => window.location.reload(),
            },
            duration: Infinity,
          })
        },
      )
      .subscribe()
    return () => {
      // removeChannel cleans up both the client-side handler AND the
      // server-side subscription handle.
      supabase.removeChannel(channel)
    }
  }, [instanceId, showToast])

  return null
}

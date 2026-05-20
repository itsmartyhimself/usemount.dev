import { AppShell } from "@/components/live/app-shell"
import { fetchInstanceRegistry } from "@/lib/registry/from-supabase"
import { createSupabaseServerClient } from "@/lib/supabase/server"

// PR7 (Step 4.3): server-side fetch of the instance's manifests, RLS-scoped
// to the signed-in user. Both the sidebar tree and the per-leaf manifest map
// are produced in one round-trip and threaded into the AppShell. If
// resolution fails or the instance has no manifests yet, AppShell still
// renders against an empty registry (the sidebar shows nothing, the canvas
// shows the empty placeholder — PR8 adds a Realtime subscription that fills
// the registry once the first sync completes).
export default async function InstancePage({
  params,
}: {
  params: Promise<{ workspace: string; repo: string; branch: string }>
}) {
  const { workspace, repo, branch } = await params

  let instanceId: string | undefined
  let repoConnectionId: string | undefined
  let manifestCount: number | undefined
  let initialRegistryArgs:
    | Awaited<ReturnType<typeof fetchInstanceRegistry>>
    | null = null

  try {
    const supabase = await createSupabaseServerClient()
    const { data: wsRows } = await supabase
      .from("workspaces")
      .select("id,name")
    const ws = (wsRows ?? []).find(
      (w) => w.name.toLowerCase() === workspace.toLowerCase(),
    )
    if (ws) {
      const { data: conns } = await supabase
        .from("repo_connections")
        .select("id,org_repo")
        .eq("workspace_id", ws.id)
        .eq("active", true)
      const conn = (conns ?? []).find(
        (c) => (c.org_repo ?? "").split("/")[1] === repo,
      )
      if (conn) {
        repoConnectionId = conn.id
        const { data: inst } = await supabase
          .from("instances")
          .select("id")
          .eq("repo_connection_id", conn.id)
          .eq("branch", branch)
          .maybeSingle()
        if (inst) {
          instanceId = inst.id
          const { count } = await supabase
            .from("component_manifests")
            .select("id", { count: "exact", head: true })
            .eq("instance_id", inst.id)
          manifestCount = count ?? 0
          initialRegistryArgs = await fetchInstanceRegistry(
            supabase,
            instanceId,
          )
        }
      }
    }
  } catch {
    // Resolution is best-effort; fall through to slug-only rendering.
  }

  if (process.env.NODE_ENV !== "production")
    console.debug("[InstancePage]", {
      workspace,
      repo,
      branch,
      instanceId,
      repoConnectionId,
      manifestCount,
      leaves: initialRegistryArgs?.registry.leaves.length ?? 0,
    })

  return (
    <AppShell
      instance={{
        workspace,
        repo,
        branch,
        instanceId,
        repoConnectionId,
        manifestCount,
      }}
      initialRegistry={initialRegistryArgs?.registry}
      initialManifests={initialRegistryArgs?.manifests}
    />
  )
}

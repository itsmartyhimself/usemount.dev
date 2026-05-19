import { AppShell } from "@/components/live/app-shell"
import { createSupabaseServerClient } from "@/lib/supabase/server"

// migration-plan Step 3: resolve the route slugs to a real instance row
// server-side (RLS as the signed-in user). The URL scheme is slug-based and
// non-unique (workspace name + repo half) — resolution is best-effort and a
// miss is non-fatal: AppShell still renders from the slugs. The component tree
// that will consume instanceId/manifestCount (the "first sync hasn't run"
// empty state) stays mock until Step 4.3 — this is the fetch seam only.
export default async function InstancePage({
  params,
}: {
  params: Promise<{ workspace: string; repo: string; branch: string }>
}) {
  const { workspace, repo, branch } = await params

  let instanceId: string | undefined
  let repoConnectionId: string | undefined
  let manifestCount: number | undefined

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
    />
  )
}

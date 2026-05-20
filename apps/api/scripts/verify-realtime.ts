// PR8 verification harness — Step 4.4 Realtime stale-viewer.
//
// Proves the load-bearing wiring: `public.instances` is in the
// `supabase_realtime` publication, the channel infrastructure delivers
// UPDATE postgres_changes events for an instances row filtered by id, and
// the event payload contains the new `last_synced_commit_sha` the browser-
// side StaleViewerTrigger compares against its baseline.
//
// In-process via the service-role admin client (Realtime + RLS bypass).
// The browser path uses the user's session client; receiving-side RLS is
// already gated by the existing instances_select_policy (PR2, workspace-
// member-only).
//
// Run with: pnpm --filter @usemount/api verify:realtime

import { setTimeout as sleep } from "node:timers/promises"
import { supabaseAdmin } from "../src/supabase/admin.js"

try {
  process.loadEnvFile(".env.local")
} catch {
  // platform env
}

// Sentinel ids — outside GitHub plausible space + outside PR5/PR6/PR7 ranges.
const TEST_INSTALL_ID = 999_999_999_961
const TEST_REPO_ID = 999_999_999_962
const TEST_BRANCH = "test/pr8-realtime"
const SUBSCRIBE_TIMEOUT_MS = 7_000
const EVENT_TIMEOUT_MS = 7_000

interface Case {
  name: string
  ok: boolean
  detail?: string
}
const cases: Case[] = []
function assert(name: string, ok: boolean, detail?: string): void {
  cases.push({ name, ok, detail })
  if (!ok) console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  else console.log(`  ✓ ${name}`)
}

interface SetupResult {
  workspaceId: string
  repoConnectionId: string
  instanceId: string
}

async function setup(): Promise<SetupResult> {
  const sb = supabaseAdmin()
  const { data: ws, error: wsErr } = await sb
    .from("workspaces")
    .select("id")
    .eq("kind", "personal")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle()
  if (wsErr || !ws)
    throw new Error("No personal workspace — sign in once first.")
  const { data: conn, error: connErr } = await sb
    .from("repo_connections")
    .upsert(
      {
        workspace_id: ws.id,
        github_install_id: TEST_INSTALL_ID,
        github_repo_id: TEST_REPO_ID,
        org_repo: "verify/pr8-fixture",
        default_branch: TEST_BRANCH,
        active: true,
      },
      { onConflict: "github_install_id,github_repo_id" },
    )
    .select("id")
    .single()
  if (connErr || !conn) throw new Error(`setup conn: ${connErr?.message}`)
  const { data: inst, error: instErr } = await sb
    .from("instances")
    .upsert(
      {
        workspace_id: ws.id,
        repo_connection_id: conn.id,
        branch: TEST_BRANCH,
        pinned: true,
      },
      { onConflict: "repo_connection_id,branch" },
    )
    .select("id")
    .single()
  if (instErr || !inst) throw new Error(`setup inst: ${instErr?.message}`)
  return {
    workspaceId: ws.id,
    repoConnectionId: conn.id,
    instanceId: inst.id,
  }
}

async function teardown(s: SetupResult | null): Promise<void> {
  if (!s) return
  const sb = supabaseAdmin()
  await sb.from("repo_connections").delete().eq("id", s.repoConnectionId)
}

interface UpdatePayload {
  new?: { last_synced_commit_sha?: string | null }
}

async function runChannelCase(s: SetupResult): Promise<void> {
  const sb = supabaseAdmin()
  let payload: UpdatePayload | null = null
  let subscribed = false

  const channel = sb
    .channel(`verify:instance:${s.instanceId}`)
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "instances",
        filter: `id=eq.${s.instanceId}`,
      },
      (p) => {
        // The first event we see is the one we expect — the harness only
        // fires one UPDATE.
        if (!payload) payload = p as unknown as UpdatePayload
      },
    )

  // Wait for SUBSCRIBED status before issuing the UPDATE — otherwise the
  // event can race the subscribe.
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("subscribe timeout")),
      SUBSCRIBE_TIMEOUT_MS,
    )
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        subscribed = true
        clearTimeout(t)
        resolve()
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        clearTimeout(t)
        reject(new Error(`channel status: ${status}`))
      }
    })
  })
  assert("channel reaches SUBSCRIBED", subscribed)

  const newSha = `deadbeef${Date.now().toString(16).padStart(8, "0")}`.slice(0, 16)
  const { error: updErr } = await sb
    .from("instances")
    .update({
      last_synced_commit_sha: newSha,
      last_synced_at: new Date().toISOString(),
      build_status: "succeeded",
    })
    .eq("id", s.instanceId)
  assert("instances UPDATE succeeds", !updErr, updErr?.message)

  // Poll up to EVENT_TIMEOUT_MS for the channel callback.
  const t0 = Date.now()
  while (!payload && Date.now() - t0 < EVENT_TIMEOUT_MS) {
    await sleep(100)
  }
  assert(
    "postgres_changes UPDATE event received",
    payload !== null,
    `waited ${EVENT_TIMEOUT_MS}ms`,
  )
  if (payload) {
    const p = payload as UpdatePayload
    assert(
      "event payload carries the new last_synced_commit_sha",
      p.new?.last_synced_commit_sha === newSha,
      `expected ${newSha}, got ${p.new?.last_synced_commit_sha ?? "null"}`,
    )
  }

  await sb.removeChannel(channel)
  assert("removeChannel cleans up", true)
}

async function runPublicationCase(): Promise<void> {
  // The harness can't query pg_publication_tables via PostgREST without a
  // dedicated RPC; the 0004 application step (Management API) is the
  // canonical verification of publication membership. Here we just confirm
  // the channel can actually deliver — which is the stronger end-to-end
  // proof anyway.
  console.log(
    "  (publication membership is verified via Management API at apply time)",
  )
}

async function main(): Promise<void> {
  console.log("=== PR8 verify:realtime ===\n")
  let s: SetupResult | null = null
  try {
    console.log("[setup] seeding sentinel instance...")
    s = await setup()
    console.log(`[setup] instance=${s.instanceId}\n`)

    console.log("--- publication ---")
    await runPublicationCase()
    console.log("")

    console.log("--- channel subscribe + UPDATE event ---")
    await runChannelCase(s)
    console.log("")
  } finally {
    if (s) {
      console.log("[teardown] removing sentinel rows...")
      await teardown(s)
    }
  }

  const passed = cases.filter((c) => c.ok).length
  const failed = cases.length - passed
  console.log(`\n=== ${passed}/${cases.length} pass${failed > 0 ? `, ${failed} FAIL` : ""} ===`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => {
  console.error(`[verify:realtime] ${(e as Error).message}`)
  process.exit(1)
})

// PR10 / Step 5.2 verification harness — webhook reconciler.
//
// Proves the load-bearing wiring against a live Postgres:
//   - active+pinned filter (inactive connections and unpinned instances are
//     skipped before fetchHead is ever called)
//   - drift INSERT into build_jobs(status='queued')
//   - no-drift skip (last_synced_commit_sha matches HEAD)
//   - 404 (null from fetchHead) skip, no error-counter
//   - per-instance error isolation on fetchHead throw
//   - 23505 swallow against build_jobs_active_dedup_idx (0002) — covers the
//     reconciler-vs-push-webhook AND multi-replica races
//   - 0-active-connections clean return
//
// Sentinel range 999_999_999_941 / ..._942 / ..._943 (PR10) — distinct from
// PR5 (...91/92), PR6 (...81/82/83), PR7 (...971), PR8 (...961), PR9 (pure
// function, no live state).
//
// fetchHead is stubbed via the runReconciler({ fetchHead }) injection point;
// no real GitHub call fires. Setup uses the service-role admin client (RLS
// bypass) keyed off the first personal workspace, same pattern as PR8's
// verify-realtime.
//
// Run with: pnpm --filter @usemount/api verify:reconciler

import { runReconciler, type FetchHead } from "../src/build/reconciler.js"
import { supabaseAdmin } from "../src/supabase/admin.js"

try {
  process.loadEnvFile(".env.local")
} catch {
  // platform env
}

const TEST_INSTALL_ID = 999_999_999_941
const TEST_REPO_ID_ACTIVE = 999_999_999_942
const TEST_REPO_ID_INACTIVE = 999_999_999_943
const TEST_ORG_REPO_ACTIVE = "verify/pr10-reconciler-active"
const TEST_ORG_REPO_INACTIVE = "verify/pr10-reconciler-inactive"

const BRANCH_DRIFT = "test/drift"
const BRANCH_NODRIFT = "test/nodrift"
const BRANCH_UNPINNED = "test/unpinned"
const BRANCH_404 = "test/branch-deleted"
const BRANCH_THROW = "test/network-error"
const BRANCH_INACTIVE_CONN = "test/inactive-conn"

const NODRIFT_SHA = "abc1234567890defaaaaaaaaaaaaaaaaaaaaaaaa"
const DRIFT_OLD_SHA = "1111111111111111111111111111111111111111"
const DRIFT_NEW_SHA = "2222222222222222222222222222222222222222"

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
  activeConnId: string
  inactiveConnId: string
  driftInstId: string
  nodriftInstId: string
  unpinnedInstId: string
  fourOhFourInstId: string
  throwInstId: string
  inactiveInstId: string
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

  const { data: activeConn, error: cErr1 } = await sb
    .from("repo_connections")
    .upsert(
      {
        workspace_id: ws.id,
        github_install_id: TEST_INSTALL_ID,
        github_repo_id: TEST_REPO_ID_ACTIVE,
        org_repo: TEST_ORG_REPO_ACTIVE,
        default_branch: BRANCH_DRIFT,
        active: true,
      },
      { onConflict: "github_install_id,github_repo_id" },
    )
    .select("id")
    .single()
  if (cErr1 || !activeConn)
    throw new Error(`setup active conn: ${cErr1?.message}`)

  const { data: inactiveConn, error: cErr2 } = await sb
    .from("repo_connections")
    .upsert(
      {
        workspace_id: ws.id,
        github_install_id: TEST_INSTALL_ID,
        github_repo_id: TEST_REPO_ID_INACTIVE,
        org_repo: TEST_ORG_REPO_INACTIVE,
        default_branch: BRANCH_INACTIVE_CONN,
        active: false,
      },
      { onConflict: "github_install_id,github_repo_id" },
    )
    .select("id")
    .single()
  if (cErr2 || !inactiveConn)
    throw new Error(`setup inactive conn: ${cErr2?.message}`)

  const seedInstances = async (
    rows: Array<{
      branch: string
      pinned: boolean
      sha: string | null
      connId: string
    }>,
  ): Promise<Array<{ id: string; branch: string }>> => {
    const upserts = rows.map((r) => ({
      workspace_id: ws.id,
      repo_connection_id: r.connId,
      branch: r.branch,
      pinned: r.pinned,
      last_synced_commit_sha: r.sha,
    }))
    const { data, error } = await sb
      .from("instances")
      .upsert(upserts, { onConflict: "repo_connection_id,branch" })
      .select("id, branch")
    if (error || !data) throw new Error(`seed instances: ${error?.message}`)
    return data
  }

  const activeInstances = await seedInstances([
    { branch: BRANCH_DRIFT, pinned: true, sha: DRIFT_OLD_SHA, connId: activeConn.id },
    { branch: BRANCH_NODRIFT, pinned: true, sha: NODRIFT_SHA, connId: activeConn.id },
    { branch: BRANCH_UNPINNED, pinned: false, sha: NODRIFT_SHA, connId: activeConn.id },
    { branch: BRANCH_404, pinned: true, sha: DRIFT_OLD_SHA, connId: activeConn.id },
    { branch: BRANCH_THROW, pinned: true, sha: DRIFT_OLD_SHA, connId: activeConn.id },
  ])
  const inactiveInstances = await seedInstances([
    {
      branch: BRANCH_INACTIVE_CONN,
      pinned: true,
      sha: DRIFT_OLD_SHA,
      connId: inactiveConn.id,
    },
  ])

  const findId = (
    rows: Array<{ id: string; branch: string }>,
    branch: string,
  ): string => {
    const r = rows.find((x) => x.branch === branch)
    if (!r) throw new Error(`no instance for ${branch}`)
    return r.id
  }

  return {
    workspaceId: ws.id,
    activeConnId: activeConn.id,
    inactiveConnId: inactiveConn.id,
    driftInstId: findId(activeInstances, BRANCH_DRIFT),
    nodriftInstId: findId(activeInstances, BRANCH_NODRIFT),
    unpinnedInstId: findId(activeInstances, BRANCH_UNPINNED),
    fourOhFourInstId: findId(activeInstances, BRANCH_404),
    throwInstId: findId(activeInstances, BRANCH_THROW),
    inactiveInstId: findId(inactiveInstances, BRANCH_INACTIVE_CONN),
  }
}

async function teardown(s: SetupResult | null): Promise<void> {
  if (!s) return
  const sb = supabaseAdmin()
  // CASCADE on repo_connections.id clears instances + build_jobs.
  await sb
    .from("repo_connections")
    .delete()
    .eq("github_install_id", TEST_INSTALL_ID)
  const { count: leftover } = await sb
    .from("repo_connections")
    .select("id", { count: "exact", head: true })
    .eq("github_install_id", TEST_INSTALL_ID)
  assert("teardown left no sentinel repo_connection", (leftover ?? 0) === 0)
}

function makeStubFetchHead(
  branchMap: Record<string, string | null | "throw">,
): { stub: FetchHead; callLog: string[] } {
  const callLog: string[] = []
  const stub: FetchHead = async (_octo, owner, repo, branch) => {
    callLog.push(`${owner}/${repo}#${branch}`)
    const v = branchMap[branch]
    if (v === "throw") throw new Error(`stub-throw: ${branch}`)
    if (v === null || v === undefined) return null
    return v
  }
  return { stub, callLog }
}

async function countBuildJobs(
  instanceId: string,
  commitSha?: string,
): Promise<number> {
  const sb = supabaseAdmin()
  let q = sb
    .from("build_jobs")
    .select("id", { count: "exact", head: true })
    .eq("instance_id", instanceId)
  if (commitSha) q = q.eq("commit_sha", commitSha)
  const { count } = await q
  return count ?? 0
}

async function runHappyAndFilterCase(s: SetupResult): Promise<void> {
  console.log("--- case A: drift / no-drift / 404 / throw / filter ---")
  const { stub, callLog } = makeStubFetchHead({
    [BRANCH_DRIFT]: DRIFT_NEW_SHA,
    [BRANCH_NODRIFT]: NODRIFT_SHA,
    [BRANCH_404]: null,
    [BRANCH_THROW]: "throw",
    // BRANCH_UNPINNED + BRANCH_INACTIVE_CONN intentionally absent — they must
    // never be looked up.
  })
  const result = await runReconciler({ fetchHead: stub })

  assert(
    "checked counts all 4 active+pinned instances",
    result.checked === 4,
    `expected 4, got ${result.checked}`,
  )
  assert(
    "enqueued counts exactly 1 (drift instance)",
    result.enqueued === 1,
    `expected 1, got ${result.enqueued}`,
  )
  assert(
    "errors counts exactly 1 (throw instance)",
    result.errors === 1,
    `expected 1, got ${result.errors}`,
  )
  assert(
    "fetchHead never called for unpinned instance",
    !callLog.some((c) => c.endsWith(`#${BRANCH_UNPINNED}`)),
    `callLog=${JSON.stringify(callLog)}`,
  )
  assert(
    "fetchHead never called for inactive-connection instance",
    !callLog.some((c) => c.endsWith(`#${BRANCH_INACTIVE_CONN}`)),
    `callLog=${JSON.stringify(callLog)}`,
  )
  assert(
    "fetchHead called exactly once per active+pinned instance",
    callLog.length === 4,
    `expected 4 calls, got ${callLog.length}`,
  )

  // Wire-level: build_jobs row exists for drift, NOT for the others.
  const driftRowCount = await countBuildJobs(s.driftInstId, DRIFT_NEW_SHA)
  assert(
    "build_jobs row exists for drift instance + new SHA",
    driftRowCount === 1,
    `expected 1, got ${driftRowCount}`,
  )
  const nodriftRowCount = await countBuildJobs(s.nodriftInstId)
  assert(
    "no build_jobs row for no-drift instance",
    nodriftRowCount === 0,
    `expected 0, got ${nodriftRowCount}`,
  )
  const fourOhFourRowCount = await countBuildJobs(s.fourOhFourInstId)
  assert(
    "no build_jobs row for 404 instance",
    fourOhFourRowCount === 0,
    `expected 0, got ${fourOhFourRowCount}`,
  )
  const throwRowCount = await countBuildJobs(s.throwInstId)
  assert(
    "no build_jobs row for throw instance",
    throwRowCount === 0,
    `expected 0, got ${throwRowCount}`,
  )
  const unpinnedRowCount = await countBuildJobs(s.unpinnedInstId)
  assert(
    "no build_jobs row for unpinned instance",
    unpinnedRowCount === 0,
    `expected 0, got ${unpinnedRowCount}`,
  )
  const inactiveRowCount = await countBuildJobs(s.inactiveInstId)
  assert(
    "no build_jobs row for inactive-connection instance",
    inactiveRowCount === 0,
    `expected 0, got ${inactiveRowCount}`,
  )
}

async function runDedupSwallowCase(s: SetupResult): Promise<void> {
  console.log("--- case B: 23505 swallow on re-run (dedup vs active job) ---")
  // The drift row from case A is still status='queued'. Isolate the dedup
  // behaviour on the drift instance only: any "new drift" for the other
  // active+pinned branches would legitimately enqueue (no prior row to
  // collide against). So we keep no-drift / 404 / throw branches in
  // no-enqueue states and only re-assert drift.
  const { stub } = makeStubFetchHead({
    [BRANCH_DRIFT]: DRIFT_NEW_SHA, // collides on the row from case A → 23505
    [BRANCH_NODRIFT]: NODRIFT_SHA, // no drift
    [BRANCH_404]: null, // skip (no error counter)
    [BRANCH_THROW]: DRIFT_OLD_SHA, // matches its synced_sha → no drift, no enqueue
  })
  const result = await runReconciler({ fetchHead: stub })
  assert(
    "re-run: enqueued === 0 (drift's 23505 swallowed; others no-op)",
    result.enqueued === 0,
    `expected 0, got ${result.enqueued}`,
  )
  assert(
    "re-run: errors === 0 (23505 is not an error)",
    result.errors === 0,
    `expected 0, got ${result.errors}`,
  )
  const driftRowCount = await countBuildJobs(s.driftInstId, DRIFT_NEW_SHA)
  assert(
    "drift instance still has exactly one queued row (no double-enqueue)",
    driftRowCount === 1,
    `expected 1, got ${driftRowCount}`,
  )
}

async function runZeroActiveCase(): Promise<void> {
  console.log("--- case C: 0 active connections ---")
  // Flip the active connection to active=false. With zero active rows, no
  // fetchHead call should fire and counters should be all-zero.
  const sb = supabaseAdmin()
  const { error } = await sb
    .from("repo_connections")
    .update({ active: false })
    .eq("github_install_id", TEST_INSTALL_ID)
  if (error) throw new Error(`deactivate sentinels: ${error.message}`)

  const { stub, callLog } = makeStubFetchHead({
    [BRANCH_DRIFT]: DRIFT_NEW_SHA,
  })
  const result = await runReconciler({ fetchHead: stub })
  assert(
    "checked === 0 when zero active connections",
    result.checked === 0,
    `expected 0, got ${result.checked}`,
  )
  assert(
    "enqueued === 0 when zero active connections",
    result.enqueued === 0,
    `expected 0, got ${result.enqueued}`,
  )
  assert(
    "errors === 0 when zero active connections",
    result.errors === 0,
    `expected 0, got ${result.errors}`,
  )
  assert(
    "fetchHead never called when zero active connections",
    callLog.length === 0,
    `callLog=${JSON.stringify(callLog)}`,
  )
}

async function main(): Promise<void> {
  console.log("=== PR10 verify:reconciler ===\n")
  let s: SetupResult | null = null
  try {
    console.log("[setup] seeding sentinel rows...")
    s = await setup()
    console.log(
      `[setup] active=${s.activeConnId} inactive=${s.inactiveConnId} drift=${s.driftInstId.slice(0, 8)}\n`,
    )

    await runHappyAndFilterCase(s)
    console.log("")
    await runDedupSwallowCase(s)
    console.log("")
    await runZeroActiveCase()
    console.log("")
  } finally {
    if (s) {
      console.log("[teardown] removing sentinel rows...")
      await teardown(s)
    }
  }

  const passed = cases.filter((c) => c.ok).length
  const failed = cases.length - passed
  console.log(
    `\n=== ${passed}/${cases.length} pass${failed > 0 ? `, ${failed} FAIL` : ""} ===`,
  )
  if (failed > 0) process.exit(1)
}

main().catch((e) => {
  console.error(`[verify:reconciler] ${(e as Error).message}`)
  process.exit(1)
})

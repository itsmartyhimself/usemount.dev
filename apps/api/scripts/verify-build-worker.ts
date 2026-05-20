// PR6 verification harness — Step 4.2 build worker primitives.
//
// Drives the worker's lease/heartbeat/complete/fail helpers directly against
// the live hosted Supabase (no Hono routes — the worker is a loop, not a
// route, so we exercise the functions in-process). Mount.config.ts static-
// parse tests run entirely against tmpfs files — no DB.
//
// The full clone→install→introspect→bundle pipeline is exercised by the
// fresh-clone E2E gate (separate session), not here. This harness validates
// every DB-driven and parser-driven primitive the worker leans on.
//
// Run with: pnpm --filter @usemount/api verify:build-worker
// Exits non-zero on any failed assertion. Cleanup is in a finally block so a
// mid-run failure still removes the sentinel rows.

import { setTimeout as sleep } from "node:timers/promises"
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  completeJob,
  failJob,
  heartbeat,
  leaseNextJob,
} from "../src/build/lease.js"
import { parseMountConfig } from "../src/build/mount-config.js"
import { supabaseAdmin } from "../src/supabase/admin.js"

// Lazy env: imports above only declare; nothing reads env until first call.
// .env.local is loaded before any of those functions fire.
try {
  process.loadEnvFile(".env.local")
} catch {
  // Platform-provided env (Railway pattern; harness is local-only today).
}

// Sentinel values — outside GitHub's plausible id space + outside PR5's range.
const TEST_INSTALL_ID = 999_999_999_981
const TEST_REPO_ID = 999_999_999_982
const TEST_BRANCH = "test/pr6-worker"

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
    throw new Error("No personal workspace found in hosted DB — sign in once first.")

  const { data: conn, error: connErr } = await sb
    .from("repo_connections")
    .upsert(
      {
        workspace_id: ws.id,
        github_install_id: TEST_INSTALL_ID,
        github_repo_id: TEST_REPO_ID,
        org_repo: "verify/pr6-fixture",
        default_branch: TEST_BRANCH,
        active: true,
      },
      { onConflict: "github_install_id,github_repo_id" },
    )
    .select("id")
    .single()
  if (connErr || !conn) throw new Error(`setup repo_connection: ${connErr?.message}`)

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
  if (instErr || !inst) throw new Error(`setup instance: ${instErr?.message}`)

  // Belt-and-braces clean any stale jobs.
  await sb.from("build_jobs").delete().eq("instance_id", inst.id)

  return {
    workspaceId: ws.id,
    repoConnectionId: conn.id,
    instanceId: inst.id,
  }
}

async function teardown(s: SetupResult | null): Promise<void> {
  if (!s) return
  const sb = supabaseAdmin()
  // Cascade chain: repo_connections → instances → build_jobs. Deleting the
  // connection cleans everything we added (mirrors PR5 pattern).
  await sb.from("repo_connections").delete().eq("id", s.repoConnectionId)
}

interface InsertOpts {
  instanceId: string
  sha: string
  status?: "queued" | "running"
  leasedAt?: Date | null
  workerId?: string | null
}

async function insertJob(opts: InsertOpts): Promise<string> {
  const { data, error } = await supabaseAdmin()
    .from("build_jobs")
    .insert({
      instance_id: opts.instanceId,
      commit_sha: opts.sha,
      status: opts.status ?? "queued",
      leased_at: opts.leasedAt?.toISOString() ?? null,
      worker_id: opts.workerId ?? null,
    })
    .select("id")
    .single()
  if (error || !data) throw new Error(`insertJob: ${error?.message}`)
  return data.id as string
}

async function getJob(id: string) {
  const { data, error } = await supabaseAdmin()
    .from("build_jobs")
    .select("*")
    .eq("id", id)
    .maybeSingle()
  if (error) throw new Error(`getJob: ${error.message}`)
  return data
}

async function clearJobs(instanceId: string): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("build_jobs")
    .delete()
    .eq("instance_id", instanceId)
  if (error) throw new Error(`clearJobs: ${error.message}`)
}

// 40-char SHA1 padding for sentinel commit hashes.
const sha = (prefix: string) => prefix + "0".repeat(40 - prefix.length)

// ─── DB-driven cases ────────────────────────────────────────────────────────

async function caseLeaseBasic(s: SetupResult, workerId: string): Promise<void> {
  console.log("case 1: lease basic — queued → running")
  await clearJobs(s.instanceId)
  const jobId = await insertJob({ instanceId: s.instanceId, sha: sha("a1") })
  const leased = await leaseNextJob(workerId)
  if (!leased || leased.id !== jobId)
    throw new Error(`expected lease ${jobId}, got ${leased?.id ?? "null"}`)
  if (leased.status !== "running")
    throw new Error(`expected status=running, got ${leased.status}`)
  if (leased.worker_id !== workerId)
    throw new Error(`expected worker_id=${workerId}, got ${leased.worker_id}`)
  if (!leased.leased_at) throw new Error("expected leased_at set")
  console.log("  ✓ lease moved job to running + set worker_id + leased_at")
}

async function caseStaleReclaim(s: SetupResult, workerId: string): Promise<void> {
  console.log("case 2: stale lease (>10min) reclaimed by new worker")
  await clearJobs(s.instanceId)
  const elevenMinAgo = new Date(Date.now() - 11 * 60 * 1000)
  const jobId = await insertJob({
    instanceId: s.instanceId,
    sha: sha("b2"),
    status: "running",
    leasedAt: elevenMinAgo,
    workerId: "DEAD_WORKER",
  })
  const leased = await leaseNextJob(workerId)
  if (!leased || leased.id !== jobId)
    throw new Error(`expected reclaim ${jobId}, got ${leased?.id ?? "null"}`)
  if (leased.worker_id !== workerId)
    throw new Error(`expected worker_id swapped to ${workerId}, got ${leased.worker_id}`)
  console.log("  ✓ stale running lease reclaimed")
}

async function caseFreshLeasePreserved(
  s: SetupResult,
  workerId: string,
): Promise<void> {
  console.log("case 3: fresh running lease (<10min) NOT reclaimed")
  await clearJobs(s.instanceId)
  const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000)
  await insertJob({
    instanceId: s.instanceId,
    sha: sha("c3"),
    status: "running",
    leasedAt: twoMinAgo,
    workerId: "OWNER_WORKER",
  })
  const leased = await leaseNextJob(workerId)
  if (leased)
    throw new Error(`expected null (fresh lease preserved), got ${leased.id}`)
  console.log("  ✓ fresh lease preserved")
}

async function caseLeaseFifo(s: SetupResult, workerId: string): Promise<void> {
  console.log("case 4: lease respects created_at order (FIFO)")
  await clearJobs(s.instanceId)
  const oldId = await insertJob({ instanceId: s.instanceId, sha: sha("d4") })
  await sleep(50) // distinct created_at
  await insertJob({ instanceId: s.instanceId, sha: sha("e5") })
  const leased = await leaseNextJob(workerId)
  if (!leased || leased.id !== oldId)
    throw new Error(`expected older ${oldId} first, got ${leased?.id ?? "null"}`)
  console.log("  ✓ older queued job leased first")
}

async function caseLeaseEmpty(workerId: string): Promise<void> {
  console.log("case 5: lease returns null when queue empty")
  const leased = await leaseNextJob(workerId)
  if (leased) throw new Error(`expected null on empty queue, got ${leased.id}`)
  console.log("  ✓ null returned for empty queue")
}

async function caseHeartbeatRefresh(
  s: SetupResult,
  workerId: string,
): Promise<void> {
  console.log("case 6: heartbeat refreshes leased_at when lease still owned")
  await clearJobs(s.instanceId)
  const jobId = await insertJob({ instanceId: s.instanceId, sha: sha("f6") })
  const leased = await leaseNextJob(workerId)
  if (!leased) throw new Error("setup: lease failed")
  const before = leased.leased_at!
  await sleep(1100) // > 1s so the timestamp delta is observable
  const ok = await heartbeat(jobId, workerId)
  if (!ok) throw new Error("expected heartbeat=true while lease still owned")
  const after = await getJob(jobId)
  if (!after?.leased_at) throw new Error("after heartbeat, leased_at must be set")
  if (after.leased_at <= before)
    throw new Error(`expected leased_at advanced; before=${before}, after=${after.leased_at}`)
  console.log("  ✓ heartbeat returned true + advanced leased_at")
}

async function caseHeartbeatStolen(
  s: SetupResult,
  workerId: string,
): Promise<void> {
  console.log("case 7: heartbeat returns false when lease stolen")
  await clearJobs(s.instanceId)
  await insertJob({ instanceId: s.instanceId, sha: sha("g7") })
  const leased = await leaseNextJob(workerId)
  if (!leased) throw new Error("setup: lease failed")
  const ok = await heartbeat(leased.id, "DIFFERENT_WORKER")
  if (ok) throw new Error("expected heartbeat=false for wrong worker_id")
  console.log("  ✓ heartbeat=false on stolen lease (wrong worker_id)")
}

async function caseComplete(s: SetupResult, workerId: string): Promise<void> {
  console.log("case 8: completeJob sets succeeded + duration + finished_at")
  await clearJobs(s.instanceId)
  await insertJob({ instanceId: s.instanceId, sha: sha("h8") })
  const leased = await leaseNextJob(workerId)
  if (!leased) throw new Error("setup: lease failed")
  await completeJob(leased.id, 1234)
  const after = await getJob(leased.id)
  if (after?.status !== "succeeded")
    throw new Error(`expected succeeded, got ${after?.status}`)
  if (after?.build_duration_ms !== 1234)
    throw new Error(`expected duration=1234, got ${after?.build_duration_ms}`)
  if (!after?.finished_at) throw new Error("expected finished_at set")
  console.log("  ✓ completeJob set succeeded + duration + finished_at")
}

async function caseFail(s: SetupResult, workerId: string): Promise<void> {
  console.log("case 9: failJob sets failed + truncated error + duration")
  await clearJobs(s.instanceId)
  await insertJob({ instanceId: s.instanceId, sha: sha("i9") })
  const leased = await leaseNextJob(workerId)
  if (!leased) throw new Error("setup: lease failed")
  const longErr = "x".repeat(5000) // > 4000 truncation point
  await failJob(leased.id, longErr, 567)
  const after = await getJob(leased.id)
  if (after?.status !== "failed")
    throw new Error(`expected failed, got ${after?.status}`)
  if (after?.error?.length !== 4000)
    throw new Error(`expected error truncated to 4000, got ${after?.error?.length}`)
  if (after?.build_duration_ms !== 567)
    throw new Error(`expected duration=567, got ${after?.build_duration_ms}`)
  console.log("  ✓ failJob set failed + truncated error + duration")
}

// ─── Mount-config static-parse cases (no DB) ────────────────────────────────

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), "usemount-mount-test-"))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function caseMountConfigRejectsCallExpression(): Promise<void> {
  console.log("case 10: mount.config.ts CallExpression value → throw")
  withTmp((dir) => {
    writeFileSync(
      path.join(dir, "mount.config.ts"),
      `export default { componentsDir: foo() }`,
    )
    try {
      parseMountConfig(dir)
      throw new Error("expected parseMountConfig to throw on CallExpression")
    } catch (e) {
      if (!/string literal|got/.test((e as Error).message))
        throw new Error(`unexpected error: ${(e as Error).message}`)
    }
  })
  console.log("  ✓ CallExpression rejected")
}

async function caseMountConfigRejectsIdentifier(): Promise<void> {
  console.log("case 11: mount.config.ts Identifier value → throw")
  withTmp((dir) => {
    writeFileSync(
      path.join(dir, "mount.config.ts"),
      `const DIR = "src/components"; export default { componentsDir: DIR }`,
    )
    try {
      parseMountConfig(dir)
      throw new Error("expected parseMountConfig to throw on Identifier")
    } catch (e) {
      if (!/string literal|got/.test((e as Error).message))
        throw new Error(`unexpected error: ${(e as Error).message}`)
    }
  })
  console.log("  ✓ Identifier reference rejected")
}

async function caseMountConfigRejectsUnknownKey(): Promise<void> {
  console.log("case 12: mount.config.ts unknown key → throw")
  withTmp((dir) => {
    writeFileSync(
      path.join(dir, "mount.config.ts"),
      `export default { someEvilKey: "x" }`,
    )
    try {
      parseMountConfig(dir)
      throw new Error("expected parseMountConfig to throw on unknown key")
    } catch (e) {
      if (!/not in allowed set/.test((e as Error).message))
        throw new Error(`unexpected error: ${(e as Error).message}`)
    }
  })
  console.log("  ✓ unknown key rejected (allowlist enforced)")
}

async function caseMountConfigFallback(): Promise<void> {
  console.log("case 13: no mount.config.ts → fallback to src/components")
  withTmp((dir) => {
    const compDir = path.join(dir, "src", "components")
    mkdirSync(compDir, { recursive: true })
    const result = parseMountConfig(dir)
    if (!result.fallbackUsed) throw new Error("expected fallbackUsed=true")
    if (result.resolvedComponentsDir !== compDir)
      throw new Error(
        `expected ${compDir}, got ${result.resolvedComponentsDir}`,
      )
  })
  console.log("  ✓ fallback resolved src/components")
}

async function caseMountConfigValid(): Promise<void> {
  console.log("case 14: valid mount.config.ts with literals → parse + resolve")
  withTmp((dir) => {
    const compDir = path.join(dir, "src", "ui")
    mkdirSync(compDir, { recursive: true })
    writeFileSync(
      path.join(dir, "mount.config.ts"),
      `export default { componentsDir: "src/ui", hidden: ["legacy"] }`,
    )
    const result = parseMountConfig(dir)
    if (result.fallbackUsed) throw new Error("expected fallbackUsed=false")
    if (result.config.componentsDir !== "src/ui")
      throw new Error(`componentsDir mismatch: ${result.config.componentsDir}`)
    if (!result.config.hidden || result.config.hidden[0] !== "legacy")
      throw new Error(`hidden mismatch: ${JSON.stringify(result.config.hidden)}`)
    if (result.resolvedComponentsDir !== compDir)
      throw new Error(
        `expected ${compDir}, got ${result.resolvedComponentsDir}`,
      )
  })
  console.log("  ✓ valid literal config parsed + resolved")
}

async function main() {
  const workerId = `verify-pr6-${process.pid}-${Date.now()}`
  let s: SetupResult | null = null
  try {
    s = await setup()
    await caseLeaseBasic(s, workerId)
    await caseStaleReclaim(s, workerId)
    await caseFreshLeasePreserved(s, workerId)
    await caseLeaseFifo(s, workerId)
    // clear before the empty-queue case so we don't lease the FIFO leftover
    await clearJobs(s.instanceId)
    await caseLeaseEmpty(workerId)
    await caseHeartbeatRefresh(s, workerId)
    await caseHeartbeatStolen(s, workerId)
    await caseComplete(s, workerId)
    await caseFail(s, workerId)
    await caseMountConfigRejectsCallExpression()
    await caseMountConfigRejectsIdentifier()
    await caseMountConfigRejectsUnknownKey()
    await caseMountConfigFallback()
    await caseMountConfigValid()
    console.log("\nALL PASS")
  } finally {
    await teardown(s)
    // Defensive post-run check — confirm nothing leaked.
    if (s) {
      const sb = supabaseAdmin()
      const { count: connsLeft } = await sb
        .from("repo_connections")
        .select("id", { count: "exact", head: true })
        .eq("github_install_id", TEST_INSTALL_ID)
      const { count: instsLeft } = await sb
        .from("instances")
        .select("id", { count: "exact", head: true })
        .eq("repo_connection_id", s.repoConnectionId)
      const { count: jobsLeft } = await sb
        .from("build_jobs")
        .select("id", { count: "exact", head: true })
        .eq("instance_id", s.instanceId)
      console.log(
        `teardown: leftover_conns=${connsLeft ?? 0}, leftover_insts=${instsLeft ?? 0}, leftover_jobs=${jobsLeft ?? 0}`,
      )
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

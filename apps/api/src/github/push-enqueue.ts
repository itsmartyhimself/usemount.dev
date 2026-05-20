import { supabaseAdmin } from "../supabase/admin.js"
import { tryConsume } from "../lib/rate-limit.js"

// Step 4.1 — turn a verified GitHub `push` payload into zero-or-more queued
// build_jobs rows. Webhook signature is verified in webhook.ts BEFORE this
// runs; this module trusts its input is GitHub-shaped but never assumes the
// caller is on the happy path (every field is treated as untrusted text).
//
// Architecture-brief §225: pinned branches auto-rebuild on push; unpinned
// branches build on demand only. So a push lookup is repo → connection(s) →
// instance(branch) → require pinned → enqueue.
//
// Two protection mechanisms, deliberately separate:
//   (a) Dedup — DB-level via UNIQUE INDEX build_jobs_active_dedup_idx
//       (status IN ('queued','running')). Concurrent identical (instance, sha)
//       INSERTs collapse to one row, the second yielding unique_violation.
//   (b) Rate-limit — in-memory token bucket per installation_id (lib/rate-
//       limit.ts). Caps the *distinct-SHA* flood that dedup cannot catch.

interface PushPayload {
  ref?: string
  before?: string
  after?: string
  deleted?: boolean
  installation?: { id?: number }
  repository?: { id?: number; full_name?: string }
}

// Per-install bucket sized for a normal "merge train" without throttling work
// (10 quick builds is generous), but bounded enough that a hostile single
// install cannot enqueue thousands in a second. Resets on apps/api restart.
const PUSH_RATE = { capacity: 10, refillPerSec: 0.5 } as const

// Discriminated outcome per (connection,instance) the push touched.
export type PushEnqueueOutcome =
  | { kind: "enqueued"; jobId: string }
  | { kind: "deduped" }
  | { kind: "rate-limited" }
  | { kind: "skipped"; reason: PushSkipReason }

export type PushSkipReason =
  | "not_branch_ref"
  | "empty_branch"
  | "branch_deleted"
  | "missing_after_sha"
  | "missing_repo_or_install"
  | "repo_lookup_failed"
  | "no_active_connection"
  | "instance_not_tracked"
  | "branch_unpinned"
  | "insert_failed"

const ZERO_SHA = /^0+$/

export async function enqueuePushBuilds(
  payload: PushPayload,
): Promise<PushEnqueueOutcome[]> {
  // 1) Branch refs only — tag pushes (refs/tags/*) do not trigger builds.
  const ref = payload.ref ?? ""
  if (!ref.startsWith("refs/heads/")) {
    return [{ kind: "skipped", reason: "not_branch_ref" }]
  }
  const branch = ref.slice("refs/heads/".length)
  if (branch.length === 0) {
    return [{ kind: "skipped", reason: "empty_branch" }]
  }

  // 2) Branch deletion: `deleted: true` OR `after` is the zero-SHA. Nothing
  // to build either way.
  const after = (payload.after ?? "").trim()
  if (payload.deleted === true || ZERO_SHA.test(after)) {
    return [{ kind: "skipped", reason: "branch_deleted" }]
  }
  // GitHub commit SHAs are 40 hex chars (or 64 for SHA-256 repos when those
  // arrive). Length 7 is the absolute floor; anything shorter is malformed.
  if (after.length < 7) {
    return [{ kind: "skipped", reason: "missing_after_sha" }]
  }

  const repoId = payload.repository?.id
  const installId = payload.installation?.id
  if (typeof repoId !== "number" || typeof installId !== "number") {
    return [{ kind: "skipped", reason: "missing_repo_or_install" }]
  }

  // 3) Rate-limit BEFORE DB work. A token spent here protects every downstream
  // SELECT/INSERT the payload would trigger.
  if (!tryConsume("push", installId, PUSH_RATE)) {
    return [{ kind: "rate-limited" }]
  }

  // 4) repo_connections matching the install AND the repo. Sanity-checking
  // both prevents a payload anomaly (install.id and repo.id from different
  // tenants) from being trusted. The UNIQUE on (install_id, repo_id) means at
  // most one row matches; the .select returns an array for forward-compat
  // with any future per-workspace connections.
  const { data: conns, error: connErr } = await supabaseAdmin()
    .from("repo_connections")
    .select("id, workspace_id")
    .eq("github_repo_id", repoId)
    .eq("github_install_id", installId)
    .eq("active", true)
  if (connErr) {
    return [{ kind: "skipped", reason: "repo_lookup_failed" }]
  }
  if (!conns || conns.length === 0) {
    return [{ kind: "skipped", reason: "no_active_connection" }]
  }

  const outcomes: PushEnqueueOutcome[] = []
  for (const conn of conns) {
    const { data: inst, error: instErr } = await supabaseAdmin()
      .from("instances")
      .select("id, pinned")
      .eq("repo_connection_id", conn.id)
      .eq("branch", branch)
      .maybeSingle()
    if (instErr || !inst) {
      outcomes.push({ kind: "skipped", reason: "instance_not_tracked" })
      continue
    }
    if (!inst.pinned) {
      outcomes.push({ kind: "skipped", reason: "branch_unpinned" })
      continue
    }

    // 5) The actual enqueue. Postgres unique_violation (SQLSTATE 23505) on
    // the partial dedup index IS the success signal for "already queued or
    // running" — surfaced as `deduped`, NOT an error. Any other error is a
    // real failure.
    const { data: job, error: jobErr } = await supabaseAdmin()
      .from("build_jobs")
      .insert({ instance_id: inst.id, commit_sha: after })
      .select("id")
      .single()
    if (job?.id) {
      outcomes.push({ kind: "enqueued", jobId: job.id })
      continue
    }
    if (jobErr && (jobErr as { code?: string }).code === "23505") {
      outcomes.push({ kind: "deduped" })
      continue
    }
    outcomes.push({ kind: "skipped", reason: "insert_failed" })
  }
  return outcomes
}

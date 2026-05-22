// Lease + heartbeat + completion helpers for the 4.2 build worker.
//
// The lease RPC (supabase/migrations/0003) atomically picks the next queued
// job OR a stale-leased one and flips it to status='running'. Heartbeat is a
// plain PostgREST update gated on (id, worker_id, status='running'); a stolen
// lease surfaces as zero affected rows so the worker aborts cleanly. We do
// NOT need a heartbeat RPC — SKIP LOCKED is only required for the lease pick.

import { supabaseAdmin } from "../supabase/admin.js"
import type { BuildJob } from "./types.js"

/**
 * Atomically lease the next available job. Returns null when nothing is
 * queued AND no running lease is stale enough to reclaim — the worker should
 * sleep and retry.
 */
export async function leaseNextJob(workerId: string): Promise<BuildJob | null> {
  const { data, error } = await supabaseAdmin()
    .rpc("lease_next_build_job", { p_worker_id: workerId })
    .maybeSingle<BuildJob>()
  if (error) throw new Error(`lease_next_build_job: ${error.message}`)
  return data ?? null
}

/**
 * Refresh leased_at so the 10-minute stale-recovery window stays open while
 * the build is in flight. Returns true if our lease is still ours; false if
 * another worker reclaimed it (caller must abort — anything we write after
 * is on a job that belongs to someone else).
 */
export async function heartbeat(jobId: string, workerId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from("build_jobs")
    .update({ leased_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("worker_id", workerId)
    .eq("status", "running")
    .select("id")
  if (error) throw new Error(`heartbeat: ${error.message}`)
  return (data?.length ?? 0) > 0
}

export async function completeJob(jobId: string, buildDurationMs: number): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("build_jobs")
    .update({
      status: "succeeded",
      finished_at: new Date().toISOString(),
      build_duration_ms: buildDurationMs,
    })
    .eq("id", jobId)
  if (error) throw new Error(`completeJob: ${error.message}`)
}

export async function failJob(
  jobId: string,
  errMsg: string,
  buildDurationMs: number,
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("build_jobs")
    .update({
      status: "failed",
      finished_at: new Date().toISOString(),
      // truncate so a giant stack trace doesn't blow up a TOAST page or the UI
      error: errMsg.slice(0, 4000),
      build_duration_ms: buildDurationMs,
    })
    .eq("id", jobId)
  if (error) throw new Error(`failJob: ${error.message}`)
}

/**
 * Record NON-FATAL build warnings on the job's `error` column WITHOUT changing
 * status. The build still completes (completeJob sets status='succeeded' and
 * does not touch `error`), so this surfaces a "succeeded-with-warnings" job —
 * e.g. the globals.css or providers bundle failed but components still built.
 * Today no web UI reads build_jobs.error to derive status (repo/instance status
 * comes from instances.build_status), so a populated error on a succeeded job
 * is safe; if a build-log surface is added later it should treat a succeeded
 * job's `error` as warnings, not a failure. Truncated like failJob.
 */
export async function recordJobWarning(jobId: string, text: string): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("build_jobs")
    .update({ error: text.slice(0, 4000) })
    .eq("id", jobId)
  if (error) throw new Error(`recordJobWarning: ${error.message}`)
}

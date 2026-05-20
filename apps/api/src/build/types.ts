// Shared types for the Step-4.2 build worker. The DB row shapes mirror
// supabase/migrations/0001_init.sql + 0002 + 0003 — narrow projections of
// what the worker actually reads back from the lease RPC and the supporting
// SELECTs in worker.ts.

export type BuildJobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled"

export interface BuildJob {
  id: string
  instance_id: string
  commit_sha: string
  status: BuildJobStatus
  leased_at: string | null
  worker_id: string | null
  started_at: string | null
  finished_at: string | null
  build_duration_ms: number | null
  log_url: string | null
  error: string | null
  created_at: string
}

export interface InstanceRow {
  id: string
  repo_connection_id: string
  branch: string
  last_synced_commit_sha: string | null
}

export interface RepoConnectionRow {
  github_install_id: number
  org_repo: string // "owner/repo"
}

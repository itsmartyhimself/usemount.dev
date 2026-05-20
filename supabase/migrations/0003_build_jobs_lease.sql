-- 4.2 build worker — atomic lease for the next build_job. PostgREST can't
-- express `FOR UPDATE SKIP LOCKED`, so the lease lives behind a SECURITY
-- DEFINER RPC the worker calls via supabaseAdmin.rpc('lease_next_build_job').
--
-- The query covers TWO cases in one atomic UPDATE:
--   (a) status='queued' — a fresh job from the push-webhook enqueue path
--       (PR5, 0002). leased_at is NULL.
--   (b) status='running' AND leased_at < now() - 10 min — a crashed worker's
--       stale lease. Reclaiming it here means a worker death never strands the
--       queue (combined with 0002's partial UNIQUE on (instance_id, commit_sha)
--       WHERE status IN ('queued','running'), new pushes for that same SHA
--       dedup against the stale job until this lease moves it forward).
--
-- Heartbeat (apps/api/src/build/lease.ts) refreshes `leased_at` on a ~2min
-- interval; if it stops, the 10min reclaim window kicks in. There is NO
-- separate heartbeat RPC — heartbeat is a plain UPDATE gated on
-- (id, worker_id, status='running') so a stolen lease (affected-row count=0)
-- surfaces to the worker for clean abort. One function is enough.
--
-- Security: SECURITY DEFINER lets the function bypass RLS while preserving
-- the row-level lock; `SET search_path = public, pg_temp` closes the
-- schema-injection vector the Supabase linter flags on SECURITY DEFINER.
-- REVOKE ALL FROM PUBLIC then GRANT EXECUTE to service_role only — apps/api
-- already uses service_role; web/anon clients never call this. RETURNS SETOF
-- lets the caller use `.maybeSingle()` and receive `null` when nothing is
-- leasable (vs. erroring on a missing record).

BEGIN;

CREATE OR REPLACE FUNCTION public.lease_next_build_job(p_worker_id text)
RETURNS SETOF public.build_jobs
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.build_jobs
  SET status = 'running',
      leased_at = now(),
      worker_id = p_worker_id,
      -- preserve the original start time on stale-lease recovery so the
      -- build_duration_ms math at finish time reflects total wall clock.
      started_at = COALESCE(started_at, now())
  WHERE id = (
    SELECT id
    FROM public.build_jobs
    WHERE (status = 'queued')
       OR (status = 'running' AND leased_at < now() - interval '10 minutes')
    ORDER BY created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
$$;

-- Supabase default-privileges hand EXECUTE on every public.* function to anon
-- and authenticated. REVOKE PUBLIC does NOT catch those role-specific grants
-- — without these two extra REVOKEs an anonymous request could call this
-- SECURITY DEFINER and lease a job. Lock down to service_role only.
REVOKE ALL ON FUNCTION public.lease_next_build_job(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lease_next_build_job(text) FROM anon;
REVOKE ALL ON FUNCTION public.lease_next_build_job(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.lease_next_build_job(text) TO service_role;

COMMIT;

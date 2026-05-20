-- 4.1 push-webhook dedup: prevent duplicate queued/running build_jobs for the
-- same (instance_id, commit_sha). GitHub webhook retries fire close together
-- (real race), and a flood of identical SHAs would otherwise queue identical
-- jobs. Partial index = only the "active" window: a SHA can rebuild after its
-- previous job finished/failed/canceled (the partial predicate excludes those
-- terminal statuses), but two concurrent INSERTs for the same active SHA
-- collide on this index and the second yields a unique_violation that apps/api
-- handles as "deduped". 4.2's worker leases out of the same table; this index
-- protects both the 4.1 write path and any future re-enqueue path.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS build_jobs_active_dedup_idx
  ON public.build_jobs (instance_id, commit_sha)
  WHERE status IN ('queued', 'running');

COMMIT;

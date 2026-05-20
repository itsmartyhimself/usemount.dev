-- PR8 (Step 4.4) — Realtime stale-viewer wiring.
--
-- The browser-side `StaleViewerTrigger` subscribes to
-- `supabase.channel('instance:<id>').on('postgres_changes', { table:
-- 'instances', filter: 'id=eq.<id>' })`. For postgres_changes events to
-- fire, `public.instances` must be a member of the `supabase_realtime`
-- publication. The 0001 init migration did not enroll any tables — fresh
-- Supabase projects ship with an empty `supabase_realtime` publication, so
-- without this step the channel subscribes successfully but never emits
-- any event.
--
-- RLS continues to gate visibility on the subscriber side: a Realtime
-- subscriber only receives events for rows the subscriber can SELECT under
-- their session's policies. The existing `instances_select_policy` (PR2,
-- workspace-member-only) already locks this down — only signed-in viewers
-- on the right workspace receive updates. No new policy required.
--
-- Idempotent — safe to re-apply.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'instances'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.instances;
  END IF;
END $$;

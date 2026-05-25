-- PR19 — in-app folder/component picker + preview-example mechanism.
--
-- instances.preview_dirs: per-instance scan-scope override. NULL = use the
-- repo's mount.config.ts componentsDir (or the fallback chain) exactly as
-- before. A jsonb array of repo-root-relative directory paths = the build
-- worker scans EXACTLY those folders (multi-root, recursive) instead of
-- mount.config — the in-app picker writes this. The picker IS the hide/show
-- mechanism when set, so mount.config's `hidden` is bypassed for an overridden
-- instance. preview_dirs REPLACES the scan scope (it does not add to the
-- mount.config dir) — the picker UI says so explicitly.
--
-- component_manifests.preview_artifact_url: storage key (signed on read, like
-- artifact_url) for a sibling `<Component>.preview.tsx` example bundle. When
-- present, the preview iframe renders that example's default export — a real,
-- self-contained usage that can supply the children/props a contentless
-- composite needs (e.g. PluginContainer) — instead of the bare component.
-- NULL = render the bare component (today's behavior).
--
-- No RLS change: the existing instances_* / cm_sel policies already gate these
-- columns by workspace membership; the build worker writes via service_role
-- (bypasses RLS). Picker mutation is owner-gated in apps/api
-- (assertWorkspaceOwner), mirroring the instances_mod RLS policy in 0001.

BEGIN;

ALTER TABLE public.instances
  ADD COLUMN IF NOT EXISTS preview_dirs jsonb;

ALTER TABLE public.component_manifests
  ADD COLUMN IF NOT EXISTS preview_artifact_url text;

COMMIT;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN CREATE TYPE workspace_kind AS ENUM ('personal','team');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE member_role AS ENUM ('owner','admin','member','viewer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE build_status AS ENUM ('queued','running','succeeded','failed','canceled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE share_scope AS ENUM ('workspace','signed_in','public');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.users (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text, avatar_url text, oauth_provider text,
  github_user_id bigint,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS users_github_user_id_idx ON public.users(github_user_id);

CREATE TABLE IF NOT EXISTS public.oauth_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_user_id));
CREATE INDEX IF NOT EXISTS oauth_identities_user_id_idx ON public.oauth_identities(user_id);

CREATE TABLE IF NOT EXISTS public.workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  kind workspace_kind NOT NULL DEFAULT 'personal',
  plan text NOT NULL DEFAULT 'free',
  owner_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  billing_seats integer NOT NULL DEFAULT 1,
  allow_public_links boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS workspaces_owner_idx ON public.workspaces(owner_user_id);

CREATE TABLE IF NOT EXISTS public.workspace_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  role member_role NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, workspace_id));
CREATE INDEX IF NOT EXISTS workspace_members_ws_idx ON public.workspace_members(workspace_id);
CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON public.workspace_members(user_id);

CREATE TABLE IF NOT EXISTS public.repo_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  github_install_id bigint NOT NULL,
  github_repo_id bigint NOT NULL,
  org_repo text,
  default_branch text NOT NULL DEFAULT 'main',
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  connected_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (github_install_id, github_repo_id));
CREATE INDEX IF NOT EXISTS repo_connections_ws_idx ON public.repo_connections(workspace_id);

CREATE TABLE IF NOT EXISTS public.instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  repo_connection_id uuid NOT NULL REFERENCES public.repo_connections(id) ON DELETE CASCADE,
  branch text NOT NULL,
  pinned boolean NOT NULL DEFAULT false,
  last_synced_commit_sha text,
  last_synced_at timestamptz,
  build_status build_status NOT NULL DEFAULT 'queued',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repo_connection_id, branch));
CREATE INDEX IF NOT EXISTS instances_ws_idx ON public.instances(workspace_id);
CREATE INDEX IF NOT EXISTS instances_repo_idx ON public.instances(repo_connection_id);

CREATE TABLE IF NOT EXISTS public.component_manifests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES public.instances(id) ON DELETE CASCADE,
  slug text NOT NULL, folder_path text, title text, kind text,
  variants_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  states_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  props_schema_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  artifact_url text, source_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (instance_id, slug));
CREATE INDEX IF NOT EXISTS component_manifests_instance_idx ON public.component_manifests(instance_id);

CREATE TABLE IF NOT EXISTS public.build_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES public.instances(id) ON DELETE CASCADE,
  commit_sha text NOT NULL,
  status build_status NOT NULL DEFAULT 'queued',
  leased_at timestamptz, worker_id text,
  started_at timestamptz, finished_at timestamptz,
  build_duration_ms integer,
  log_url text, error text,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS build_jobs_queue_idx ON public.build_jobs(status, created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS build_jobs_instance_idx ON public.build_jobs(instance_id);

CREATE TABLE IF NOT EXISTS public.share_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES public.instances(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  scope share_scope NOT NULL DEFAULT 'signed_in',
  created_by uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  expires_at timestamptz, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS share_links_instance_idx ON public.share_links(instance_id);

CREATE TABLE IF NOT EXISTS public.component_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES public.instances(id) ON DELETE CASCADE,
  manifest_id uuid REFERENCES public.component_manifests(id) ON DELETE SET NULL,
  viewer_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  viewed_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS component_views_instance_idx ON public.component_views(instance_id);

CREATE OR REPLACE FUNCTION public.is_workspace_member(p_workspace_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.workspace_members
    WHERE workspace_id = p_workspace_id AND user_id = p_user_id); $$;
CREATE OR REPLACE FUNCTION public.is_workspace_owner(p_workspace_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.workspace_members
    WHERE workspace_id = p_workspace_id AND user_id = p_user_id AND role = 'owner'); $$;
REVOKE EXECUTE ON FUNCTION public.is_workspace_member(uuid,uuid) FROM public;
REVOKE EXECUTE ON FUNCTION public.is_workspace_owner(uuid,uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.is_workspace_member(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_workspace_owner(uuid,uuid) TO authenticated;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.repo_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.component_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.build_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.share_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.component_views ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_select_self ON public.users;
CREATE POLICY users_select_self ON public.users FOR SELECT TO authenticated USING (id = auth.uid());
DROP POLICY IF EXISTS users_update_self ON public.users;
CREATE POLICY users_update_self ON public.users FOR UPDATE TO authenticated
  USING (id = auth.uid()) WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS oauth_identities_select_self ON public.oauth_identities;
CREATE POLICY oauth_identities_select_self ON public.oauth_identities
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS workspaces_select_member ON public.workspaces;
CREATE POLICY workspaces_select_member ON public.workspaces
  FOR SELECT TO authenticated USING (public.is_workspace_member(id, auth.uid()));
DROP POLICY IF EXISTS workspaces_modify_owner ON public.workspaces;
CREATE POLICY workspaces_modify_owner ON public.workspaces FOR ALL TO authenticated
  USING (public.is_workspace_owner(id, auth.uid()))
  WITH CHECK (public.is_workspace_owner(id, auth.uid()));

DROP POLICY IF EXISTS wm_select_member ON public.workspace_members;
CREATE POLICY wm_select_member ON public.workspace_members FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));
DROP POLICY IF EXISTS wm_modify_owner ON public.workspace_members;
CREATE POLICY wm_modify_owner ON public.workspace_members FOR ALL TO authenticated
  USING (public.is_workspace_owner(workspace_id, auth.uid()))
  WITH CHECK (public.is_workspace_owner(workspace_id, auth.uid()));

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['repo_connections','instances'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %1$s_sel ON public.%1$s;', t);
    EXECUTE format($f$CREATE POLICY %1$s_sel ON public.%1$s FOR SELECT TO authenticated
      USING (public.is_workspace_member(workspace_id, auth.uid()));$f$, t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_mod ON public.%1$s;', t);
    EXECUTE format($f$CREATE POLICY %1$s_mod ON public.%1$s FOR ALL TO authenticated
      USING (public.is_workspace_owner(workspace_id, auth.uid()))
      WITH CHECK (public.is_workspace_owner(workspace_id, auth.uid()));$f$, t);
  END LOOP; END $$;

DROP POLICY IF EXISTS cm_sel ON public.component_manifests;
CREATE POLICY cm_sel ON public.component_manifests FOR SELECT TO authenticated USING (EXISTS (
  SELECT 1 FROM public.instances i WHERE i.id = instance_id
    AND public.is_workspace_member(i.workspace_id, auth.uid())));
DROP POLICY IF EXISTS bj_sel ON public.build_jobs;
CREATE POLICY bj_sel ON public.build_jobs FOR SELECT TO authenticated USING (EXISTS (
  SELECT 1 FROM public.instances i WHERE i.id = instance_id
    AND public.is_workspace_member(i.workspace_id, auth.uid())));
DROP POLICY IF EXISTS sl_sel ON public.share_links;
CREATE POLICY sl_sel ON public.share_links FOR SELECT TO authenticated USING (EXISTS (
  SELECT 1 FROM public.instances i WHERE i.id = instance_id
    AND public.is_workspace_member(i.workspace_id, auth.uid())));
DROP POLICY IF EXISTS sl_mod ON public.share_links;
CREATE POLICY sl_mod ON public.share_links FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.instances i WHERE i.id = instance_id
    AND public.is_workspace_owner(i.workspace_id, auth.uid())))
  WITH CHECK (created_by = auth.uid());
DROP POLICY IF EXISTS cv_ins ON public.component_views;
CREATE POLICY cv_ins ON public.component_views FOR INSERT TO authenticated WITH CHECK (EXISTS (
  SELECT 1 FROM public.instances i WHERE i.id = instance_id
    AND public.is_workspace_member(i.workspace_id, auth.uid())));
DROP POLICY IF EXISTS cv_sel ON public.component_views;
CREATE POLICY cv_sel ON public.component_views FOR SELECT TO authenticated USING (EXISTS (
  SELECT 1 FROM public.instances i WHERE i.id = instance_id
    AND public.is_workspace_member(i.workspace_id, auth.uid())));
-- apps/api uses the service_role key → bypasses RLS; the build worker writes
-- manifests/jobs/views without needing INSERT policies here.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_provider text; v_provider_id text; v_avatar text; v_ws_id uuid;
BEGIN
  SELECT i.provider, i.identity_data->>'provider_id', i.identity_data->>'avatar_url'
    INTO v_provider, v_provider_id, v_avatar
  FROM auth.identities i WHERE i.user_id = NEW.id
  ORDER BY (i.provider = 'github') DESC, i.created_at ASC LIMIT 1;
  v_provider := COALESCE(v_provider, NEW.raw_app_meta_data->>'provider', 'github');
  v_provider_id := COALESCE(v_provider_id, NEW.raw_user_meta_data->>'provider_id',
                            NEW.raw_user_meta_data->>'sub');
  v_avatar := COALESCE(v_avatar, NEW.raw_user_meta_data->>'avatar_url');
  INSERT INTO public.users (id, email, avatar_url, oauth_provider, github_user_id)
  VALUES (NEW.id, NEW.email, v_avatar, v_provider,
          CASE WHEN v_provider = 'github' AND v_provider_id ~ '^\d+$'
               THEN v_provider_id::bigint ELSE NULL END)
  ON CONFLICT (id) DO NOTHING;
  IF v_provider_id IS NOT NULL THEN
    INSERT INTO public.oauth_identities (user_id, provider, provider_user_id)
    VALUES (NEW.id, v_provider, v_provider_id)
    ON CONFLICT (provider, provider_user_id) DO NOTHING;
  END IF;
  INSERT INTO public.workspaces (name, kind, owner_user_id)
  VALUES ('Personal', 'personal', NEW.id) RETURNING id INTO v_ws_id;
  INSERT INTO public.workspace_members (user_id, workspace_id, role)
  VALUES (NEW.id, v_ws_id, 'owner');
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

COMMIT;

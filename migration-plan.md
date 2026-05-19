# Migrate usemount.dev from demo to live (Steps 0 → 5)

## Context

The frontend is feature-complete at the UI/styling layer but runs entirely on hardcoded demo data. The architecture is fully locked in `architecture-brief.md` and `dashboard-build-plan.md` — an 8-step build sequence, Supabase + Railway + GitHub App, ephemeral builds, react-docgen-typescript manifest generation. None of the external infra is provisioned, none of the backend is wired. The migration replaces demo data sources with live ones following the existing plan, with the cutline at **end of Step 5 (Robust MVP)** — a real repo connectable, real sync running, manifest auto-generation honest enough for the first two real clients (Persona A/C).

Two things the user named are already resolved in the docs:
- **The "install something into customer git"** = a GitHub App (`usemount.dev`) customers install per-repo. **No package goes into customer code.** Optional `mount.config.ts` at repo root is config only.
- **Supabase** is the chosen data layer (auth, Postgres, Storage, Realtime, RLS). No second decision is needed.

The `/playground` route is a dev-only component gallery (10 specimen files), not the app shell. The real app shell is at `/[workspace]/[repo]/[branch]`. Playground stays for internal review but never ships to prod.

---

## Current state — assessment

| Layer | Status | Notes |
|---|---|---|
| Frontend UI/styling | ✅ ~85% | Sidebar, canvas, props panel, login, dashboard, connect, breadcrumb — all built |
| Token system | ✅ 100% | `apps/web/app/globals.css` complete |
| Manifest contract | ✅ 100% | `apps/web/lib/registry/manifest-types.ts` is the live shape |
| Demo data | 🟡 In place | `lib/dashboard/demo.ts` + `lib/registry/data.ts` — to be replaced |
| Step 1 (mock dashboard) | ✅ ~done | All routes exist with mock data |
| Backend (`apps/api`) | ⚠️ Stub | Only `/health`. Hono skeleton ready |
| `packages/shared` | ⚠️ Empty | `export {}` — needs shared types |
| External infra | 🚫 None | Supabase, GitHub App, Railway not provisioned |
| Auth | 🚫 None | No `@supabase/supabase-js`, no OAuth wiring |
| Build pipeline | 🚫 None | The big Step 4 work |

---

## Plan

### Step 0 — Provision external infra (small, blocking)

Manual, one-time. Do before any backend code lands.

1. **Supabase project**: create at supabase.com. Enable Auth (GitHub + Google providers), Postgres, Storage, Realtime, RLS. Capture URL + anon key + service-role key.
2. **GitHub App**: register at github.com/settings/apps. Name "usemount.dev". Permissions: `contents: read`, `metadata: read`, `pull_requests: read`. Webhook events: `push`, `installation_repositories`, `repository`. Generate private key. Set webhook URL (Railway URL placeholder, update post-deploy).
3. **Railway project**: create at railway.app. Two services from this monorepo: `apps/web` (Next.js) and `apps/api` (Hono). Connect to GitHub repo for auto-deploy.
4. **Env files**: add `.env.local` to `apps/web` and `apps/api` (gitignored). Add `.env.example` (committed) listing every key without values. Update `apps/api/src/index.ts` to require the keys it needs at boot.
5. **CI/deploy hardening** (do when the first `.github/workflows/*` lands — the repo has none today): no `pull_request_target` running checkout'd PR code; pin third-party actions by full commit SHA, not tag; least-scope `GITHUB_TOKEN` / OIDC, no long-lived cloud creds in workflow env; enable GitHub Actions cache scoping. This closes the exact "Mini Shai-Hulud" (May 2026) vector — it was CI Pwn-Request + cache poisoning, not malicious packages. Dependency side is already hardened: `pnpm-workspace.yaml` sets `minimumReleaseAge: 10080` (7-day quarantine) + `blockExoticSubdeps`, and `onlyBuiltDependencies` gates install scripts. Railway is self-hosted, so before this cutover confirm `next` ≥ 16.2.6 (SSRF CVE-2026-44578 / middleware-bypass fixes are self-hosted-only) and keep it patched.

**Verification**: `pnpm dev` boots both apps without env errors. `curl <api-url>/health` returns ok. Supabase dashboard shows the project. GitHub App page shows the registered app.

---

### Step 1.5 — Pre-migration cleanup (small)

Done in one PR before Step 2.

1. **Gate `/playground` to dev only**: in `apps/web/app/playground/page.tsx`, return `notFound()` when `process.env.NODE_ENV === 'production'`. Same for `/playground/specimens/*` if any have their own pages. Verify a prod build (`pnpm build && pnpm start`) returns 404 on the route.
2. **Wire route params on AppShell page**: `apps/web/app/[workspace]/[repo]/[branch]/page.tsx` currently mounts AppShell with the demo registry and ignores `params.workspace`, `params.repo`, `params.branch`. **In Next.js 16 `params` is a Promise** — read them with `const { workspace, repo, branch } = await params`. Same applies to every route handler that reads `params`, `cookies()`, `headers()`, `searchParams`. Check `node_modules/next/dist/docs/` before writing (per `AGENTS.md`). Pass params down to AppShell as an `instance` prop. **Don't fetch yet** — just thread params through so Step 3 can drop the fetch in.
3. **Archive ephemeral planning docs**: move `Initial task research + app shell layout.md` to `docs/archive/` (or `.archive/`). Leave `architecture-brief.md` and `dashboard-build-plan.md` at root through Step 5; consolidate after.
4. **Disable empty-state secondary CTA until Step 5+**: `dashboard-page/empty-state.tsx` secondary CTA currently points to `/playground/specimens`. The "Try with sample" flow needs a public `usemount.dev/sample-components` repo (decision deferred past Step 5 per `dashboard-build-plan.md` Open Decision #2). Hide the CTA entirely for now rather than ship a known-broken affordance — re-enable it once the sample repo is content-complete.

**Verification**: prod build 404s on `/playground`; AppShell page logs params on mount; archived doc no longer at root.

---

### Step 2 — Auth + Supabase wired (small-medium)

Replace mock auth + mock dashboard data with real Supabase reads. Per `dashboard-build-plan.md` Step 2.

1. `pnpm --filter web add @supabase/supabase-js`. Create `apps/web/lib/supabase/client.ts` (browser) and `apps/web/lib/supabase/server.ts` (server-side, for route handlers / RSC).
2. **Move `ComponentManifest` to `packages/shared` first.** Currently lives in `apps/web/lib/registry/manifest-types.ts`. Once `apps/api`'s build worker emits manifests (Step 4.2), it cannot depend on `apps/web`. Move the file to `packages/shared/src/manifest.ts`, re-export from the old path to keep frontend consumers unbroken. Same destination receives `Workspace`/`Repo`/`Branch`/`User` types extracted from `lib/dashboard/demo.ts` later in this step.
3. **OAuth wiring**: `/login` page's two buttons → `supabase.auth.signInWithOAuth({ provider: 'github' | 'google', options: { redirectTo: '/' } })`. Add `/auth/callback/route.ts` to exchange the code and redirect to `/`. Route handler uses `await cookies()` (Next 16).
4. **Postgres schema**: SQL migration creating `users`, `oauth_identities`, `workspaces`, `workspace_members`, `repo_connections`, `instances`, `component_manifests`, `build_jobs`, `share_links` per `architecture-brief.md` §2. RLS policies: members can read their workspace's rows; only owners can mutate. Save migration in `apps/api/sql/0001_init.sql` (or `supabase/migrations/`). **Telemetry from day one** (architecture brief decision #15): `build_jobs.build_duration_ms` column, plus a `component_views` table (instance_id, manifest_id, viewer_user_id, viewed_at) appended on every manifest load. No UI yet — just data accumulating so cost/usage shape is visible before pricing decisions.
5. **OAuth identity bookkeeping**: on Supabase `auth.users` insert, trigger inserts a `users` row + an `oauth_identities` row capturing `(provider, provider_user_id)` from the OAuth payload. This row is **the seam** that Step 3 uses to match GitHub App installation events back to a user — verify the `provider_user_id` (GitHub numeric user id, not login) is captured, not just the email.
6. **Refactor demo hooks, preserve their API**:
   - `apps/web/hooks/use-recent-repos.ts` → call Supabase `from('repo_connections').select(...)` instead of returning `DEMO_REPOS`. Keep hook signature.
   - `apps/web/hooks/use-repo-search.ts` → debounced Supabase query. Keep signature.
   - `apps/web/lib/dashboard/state.tsx` (`DashboardStateProvider`) → fetch workspaces/repos on mount via Supabase. Pattern stays — only the data source changes.
   - `apps/web/components/live/dashboard-nav/nav-avatar.tsx` → bind to `supabase.auth.getUser()` instead of `MOCK_USER`.
7. **Auto-create personal workspace on signup**: Supabase Postgres trigger on `auth.users` insert → insert row into `workspaces` with `kind='personal'` + matching `workspace_members` row.
8. **Delete demo data**: once hooks call Supabase, remove `apps/web/lib/dashboard/demo.ts` and the `?state=empty` query-param toggle. Types moved to `packages/shared` in step 2 above.

**Verification**: log out / log in via GitHub and Google works. New user lands on empty dashboard. Supabase dashboard shows the user row + auto-created personal workspace. `useRecentRepos` returns `[]` for a fresh user. Filter pills filter against real rows. No grep hits on `DEMO_REPOS` / `MOCK_USER` in `apps/web/`.

---

### Step 3 — GitHub App + repo connections (medium)

Connect flow becomes real. Per `dashboard-build-plan.md` Step 3.

1. **`apps/api` endpoints** (Hono routes):
   - `POST /github/install-callback` — receives GitHub App install redirect. **User matching**: payload contains `installation.account.id` (GitHub numeric user id). Look up the user via `SELECT user_id FROM oauth_identities WHERE provider='github' AND provider_user_id = $1`. No match → stash the install in a `pending_installations` row keyed on the GitHub user id, surface a "link GitHub identity" prompt next time that GitHub identity signs in. With match → persist `repo_connection` rows for selected repos.
   - `GET /github/installations/:userId` — lists repos the user's GitHub identity can see.
   - `POST /repo-connections` — given an install + repo + workspace, creates the connection. **Default-pin branches** on create: `main` plus any branches matching the globs `feat/*` and `release/*` (per `dashboard-build-plan.md` Open Decision #4). User can curate after.
   - `GET /repos/:repoId/branches` — fetches branches via GitHub App installation token. Used by InstanceBreadcrumb dropdown.
2. **GitHub App auth helper**: `apps/api/src/github/auth.ts` — generates JWT from app private key, exchanges for installation token. Use `@octokit/auth-app` or hand-roll.
3. **Frontend connect flow**: `apps/web/components/live/connect-repo-form/connect-repo-form.tsx` → POST to `/repo-connections` instead of demo client-state. Redirect to `/[workspace]/[repo]/main` on success.
4. **`useInstanceBranches(repoId)` hook** (new, per ROADMAP): call `GET /repos/:repoId/branches`. Replace `MOCK_INSTANCE` in `apps/web/components/live/sidebar-panel/sidebar-header-zone.tsx`.
5. **AppShell fetches its instance**: `[workspace]/[repo]/[branch]/page.tsx` now calls Supabase to load the `instance` row + manifest list (empty for now). Sidebar renders an empty tree with a "first sync hasn't run yet" empty-state until Step 4 lands.
6. **Webhook handlers for lifecycle events**: `installation_repositories.removed`, `repository.archived`, `repository.renamed` — handlers in `apps/api/src/github/webhook.ts`. Mark connections as inactive. (Per architecture brief §11.)

**Verification**: log in, click "+ Connect new repo", install the GitHub App on a test repo, select a repo, see it appear in the dashboard. Click into it → AppShell renders with empty sidebar + "First sync running" state. Branch dropdown shows real branches. Uninstall the app → connection marked inactive.

---

### Step 4 — First end-to-end sync (large, the bottleneck)

The hard step. Per `dashboard-build-plan.md` Step 4 + `architecture-brief.md` §3.

**Step 4.0 — Day-1 spike (do first)**: write a 200-line standalone Node script (`apps/api/scripts/spike.ts`) that:
1. Clones this usemount.dev repo to `/tmp`.
2. Runs `react-docgen-typescript` on `apps/web/components/live/button/`.
3. Runs esbuild on the same file.
4. Prints the manifest JSON + reports bundle size + duration.

Then run it on one real customer codebase (the 700-person Persona C target). The output decides whether the architecture holds or needs incremental builds / worker farm sooner.

**Step 4.1 — Webhook receiver**: `POST /github/webhook` in `apps/api`. **HMAC signature verification is required, not optional** — without it, anyone with the webhook URL can forge `push` events and trigger arbitrary builds. Use `@octokit/webhooks` or `crypto.timingSafeEqual` against `x-hub-signature-256` with the app's webhook secret. Reject any request that fails verification with 401 before parsing. On verified `push`, insert a `build_jobs` row with `status='queued'` — that's the whole queue (see 4.2).

**Step 4.2 — Build worker**: **`build_jobs` is the queue.** No BullMQ, no Redis, no in-memory queue — Railway redeploys would lose them. Worker loop in `apps/api/src/build/worker.ts`:
```
UPDATE build_jobs SET status='running', leased_at=now(), worker_id=$me
WHERE id = (
  SELECT id FROM build_jobs
  WHERE status='queued' AND (leased_at IS NULL OR leased_at < now() - interval '10 min')
  ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
) RETURNING *;
```
Heartbeat `leased_at` while running; a stale lease (>10min) is reclaimable. On success: `status='succeeded'`, `build_duration_ms` written. On failure: `status='failed'`, `error` populated.

Per-job worker:
1. Resolve install token → shallow-clone repo at the pushed commit to a tmpfs sandbox.
2. Detect components dir + globals.css. Try `mount.config.ts` first; fall back to `src/components`, `components`, `app/components`. If both fail, write `build_jobs.error = 'no_components_dir'` and surface in UI via the "couldn't find components" connect screen.
3. Diff against `instances.last_synced_commit_sha` to get changed component files (first-sync = all components).
4. Run esbuild per-component (shared deps graph). Output per-component JS + extracted CSS.
5. Run `react-docgen-typescript` on each component → emit a `ComponentManifest` from `@usemount/shared` (the moved type).
6. Upload bundles to Supabase Storage; insert/update `component_manifests` rows with artifact URL + `source_hash`.
7. Update `instances.last_synced_commit_sha` and `last_synced_at`. Destroy sandbox.

**Step 4.3 — Iframe runtime + canvas wiring + sandbox hardening**:
1. New `apps/web/app/preview/[manifestId]/route.ts` — serves a minimal HTML doc that mounts the bundle and supplies router + theme defaults per architecture brief §3.
2. **Iframe sandboxing is mandatory at this step, not later** (per `apps/web/ROADMAP.md` §Component rendering). The iframe element gets `sandbox="allow-scripts"` (no `allow-same-origin`). Response sets a strict CSP: `default-src 'none'; script-src 'self' <storage-domain>; style-src 'self' 'unsafe-inline'; connect-src 'none'; frame-ancestors 'self'`. Without this, a malicious customer component can reach host cookies/storage.
3. Replace `manifest.render(props)` in canvas/stage with iframe mount: load `<iframe src={...} sandbox="allow-scripts">`, send props via `postMessage` over a narrow protocol (typed message kinds: `init`, `setProps`, `error`, `ready`). Existing `controls` schema drives the same variants/sizes/booleans panel.
4. Replace `apps/web/components/live/sidebar-panel/sidebar-panel-provider.tsx` `DEMO_REGISTRY` source with Supabase query keyed on `instance_id`. Hook keeps its signature.
5. Append a `component_views` row each time a manifest mounts (the day-one telemetry from Step 2).
6. Delete `apps/web/lib/registry/data.ts` once provider reads real data.

**Step 4.4 — Realtime stale-viewer**:
1. Replace `apps/web/components/live/app-shell/stale-viewer-trigger.tsx`'s 30s `setTimeout` with `supabase.channel('instance:${id}').on('postgres_changes', { table: 'instances', filter: 'id=eq.${id}' })` listening for `last_synced_commit_sha` changes.

**Verification**: connect this usemount.dev repo to itself. Push a button color change. Watch the dashboard show "syncing → synced" within a minute. Refresh and see the change. Open the same instance in a second tab, push another change → first tab shows the stale-viewer toast.

---

### Step 5 — Manifest auto-generation polish (medium)

Per `dashboard-build-plan.md` Step 5 + `architecture-brief.md` §11.

1. **Provider auto-detect**: build worker scans `app/layout.tsx` (or equivalent). If `ThemeProvider`, `QueryClientProvider`, `NextIntlProvider`, etc. wrap `{children}`, generate a `providers.auto.tsx` wrapper file in the bundle and apply it in the iframe runtime. Common providers covered: theme, react-query, next-themes, next-intl, jotai/zustand stores.
2. **`canvas.providers.tsx` fallback**: when present at customer repo root, build worker copies it into the bundle. Iframe wraps every component with it before render.
3. **`Component.canvas.tsx` override file**: per-component opt-in enrichment. If `Button.canvas.tsx` exists next to `Button.tsx`, its exported `controls` merge into / override the auto-generated manifest's controls. Document the surface in `docs/canvas-overrides.md`.
4. **Generics / discriminated unions**: `react-docgen-typescript` chokes on these. Detect → emit manifest with `controls: {}` (renders at default, no toggle rows) → mark in UI as "limited introspection". Component still appears, still previews.
5. **Failure-mode dispositions**: implement the eight cases in `architecture-brief.md` §3:
   - RSCs detected → "Server component — not supported" leaf
   - Build-fail components → grayed leaf with inline error
   - Top-of-module crashes → "couldn't initialize" tile
   - Network-dependent → render in loading/empty state
6. **Support-matrix gate at connect**: connect flow checks `package.json` for React 19+, Next 16+ or Vite 5+, Tailwind v4+, TS 5+. Unsupported → blocking "not yet supported" screen with the unsupported items listed.
7. **Webhook reconciler** (cheap insurance per architecture brief §11): Railway cron or `apps/api` scheduled job runs every 2 hours. For every active `repo_connection`, fetch each pinned branch's HEAD SHA via the GitHub App. Compare to the matching `instance.last_synced_commit_sha`. If diverged, enqueue a `build_jobs` row. Catches missed webhooks before they become permanent staleness.

**Deferred past Step 5 cutline** (explicit):
- `LinkGitHubDialog` — only matters once Google-first viewers try to connect a repo (Persona B/D). Not blocking dogfood with Personas A/C.
- "Try with sample repo" CTA — requires content-complete public `usemount.dev/sample-components` repo.
- Comments / share links / team workspaces — Step 6/7 work.

**Verification**: connect a repo with a `ThemeProvider` → previews render with theme applied. Connect a repo with an RSC → it appears in sidebar with the not-supported note. Connect a JS-only repo → connect flow blocks with clear message. Drop a `Button.canvas.tsx` into this repo and watch new presets show up after sync. Disable GitHub webhooks temporarily, push a change, wait 2 hours → reconciler picks it up and rebuilds.

---

## Codebase cleanup (concurrent with steps above)

Done as each step lands; not a separate phase.

- **After Step 2**: delete `apps/web/lib/dashboard/demo.ts`. Move `Workspace`/`Repo`/`Branch`/`User` types to `packages/shared/src/types.ts`.
- **After Step 4.3**: delete `apps/web/lib/registry/data.ts` (DEMO_REGISTRY). Keep `manifest-types.ts` and `manifests.ts` — those are the live contract.
- **After Step 5**: consolidate `architecture-brief.md` + `dashboard-build-plan.md` into a single `docs/architecture.md`. Move `ROADMAP.md` into `docs/`. Trim `CLAUDE.md` to durable WHAT/WHY only.
- **Throughout**: replace each `// TODO:` (21 currently) with the implementation. The TODO inventory is in `apps/web/ROADMAP.md` — every TODO cites its ROADMAP section, so trace is preserved.

**Hooks/state to preserve (re-wire, don't rewrite)**:
- `apps/web/hooks/use-recent-repos.ts` — keep signature
- `apps/web/hooks/use-repo-search.ts` — keep signature
- `apps/web/lib/dashboard/state.tsx` (`DashboardStateProvider`) — keep pattern
- `apps/web/components/live/sidebar-panel/sidebar-panel-provider.tsx` — keep pattern
- `apps/web/lib/registry/manifest-types.ts` — **the contract; do not change**
- `apps/web/lib/registry/manifests.ts` — manifest loader; expand registration but keep shape

---

## Critical files

**To create**
- `apps/api/src/github/auth.ts` — App JWT → installation token
- `apps/api/src/github/webhook.ts` — HMAC-verified webhook + lifecycle handlers
- `apps/api/src/github/install-callback.ts` — install → `oauth_identities` matching → `repo_connection` rows
- `apps/api/src/build/worker.ts` — `FOR UPDATE SKIP LOCKED` queue consumer
- `apps/api/src/build/reconciler.ts` — every-2h pinned-branch HEAD diff
- `apps/api/sql/0001_init.sql` — schema (incl. `build_duration_ms`, `component_views`)
- `apps/web/lib/supabase/{client,server}.ts` — Supabase clients
- `apps/web/app/auth/callback/route.ts` — OAuth code exchange
- `apps/web/app/preview/[manifestId]/route.ts` — iframe runtime host (CSP set here)
- `apps/web/hooks/use-instance-branches.ts` — replaces `MOCK_INSTANCE`
- `packages/shared/src/manifest.ts` — `ComponentManifest` (moved from web; re-export stub stays at old path)
- `packages/shared/src/types.ts` — `Workspace`, `Repo`, `Branch`, `User` extracted from demo.ts

**To modify**
- `apps/api/src/index.ts` — boot, env validation, route mounting, worker startup
- `apps/web/app/login/page.tsx` — real OAuth
- `apps/web/app/[workspace]/[repo]/[branch]/page.tsx` — `await params`, fetch instance
- `apps/web/components/live/dashboard-nav/nav-avatar.tsx` — Supabase Auth user
- `apps/web/components/live/connect-repo-form/connect-repo-form.tsx` — real connect POST
- `apps/web/components/live/sidebar-panel/sidebar-panel-provider.tsx` — Supabase registry
- `apps/web/components/live/sidebar-panel/sidebar-header-zone.tsx` — real branches
- `apps/web/components/live/app-shell/stale-viewer-trigger.tsx` — Realtime sub
- `apps/web/hooks/use-recent-repos.ts`, `use-repo-search.ts` — re-wire to Supabase
- `apps/web/lib/dashboard/state.tsx` — Supabase fetch

**To delete (after consumers migrate)**
- `apps/web/lib/dashboard/demo.ts`
- `apps/web/lib/registry/data.ts`
- `apps/web/lib/registry/manifest-types.ts` (after move; the stub re-export can persist a release or two before final removal)
- `Initial task research + app shell layout.md` (move to `docs/archive/`)

**Do not touch**
- The `ComponentManifest` shape itself — locked contract, only its location moves
- `apps/web/components/imports/**` — shadcn imports, never edit
- `apps/web/app/globals.css` — token system
- `apps/web/AGENTS.md`, `apps/web/CONVENTIONS.md`, `apps/web/CLAUDE.md` — rules

---

## End-to-end verification (when Step 5 lands)

A new user can:
1. Visit the deployed Railway URL → land on `/login`.
2. Sign in with GitHub OAuth → land on empty dashboard, personal workspace auto-created.
3. Click "+ Connect new repo" → install usemount.dev GitHub App on a real repo → see the repo appear in the dashboard, status "syncing".
4. Wait ~30–120s → status flips to "synced". Click into the repo → AppShell renders with real components in the sidebar tree.
5. Click any component leaf → canvas mounts the live iframe preview. Variants/sizes/booleans panel auto-populates from TypeScript prop types. Hover/animations/state all real.
6. Push a change to the connected branch → within ~60s, an open viewer sees the "new version available — refresh" toast.
7. Drop a `Button.canvas.tsx` next to a `Button.tsx` in the repo → new named presets show up after next sync.
8. Try to connect a JS-only repo → connect flow blocks with the support-matrix error.

Day-1 spike (Step 4.0) confirms the build pipeline holds on the 700-person codebase before Step 4.2 commits to the full architecture.

<!--
═══════════════════════════════════════════════════════════════════════════
  MIGRATION LOG — appended by the executing agent. Everything ABOVE this line
  is the original plan, unchanged. Entries below are XML (deliberately distinct
  from the plan's prose) recording, for future agents, WHAT was set up and HOW.
  No secret values appear here by policy: credentials live only in gitignored
  .env.local files + Railway service variables, and were handed to the human
  out-of-band.
═══════════════════════════════════════════════════════════════════════════
-->
<migration-log>
  <pr id="1" branch="feat/migration-step-0" base="staging" covers="Step 0, Step 1.5"
      status="complete" verified="true" date="2026-05-18">

    <secrets-policy>
      No tokens, keys, passwords, client/webhook secrets, or private keys are
      recorded in this repo. Runtime secrets: apps/web/.env.local and
      apps/api/.env.local (gitignored) + Railway per-service variables. The
      Supabase PAT and Railway team token used for provisioning were supplied
      for this session only and never persisted. Only non-secret structural
      identifiers (project refs, service ids, public domains, GitHub App
      id/slug) appear below — these are public-by-design.
    </secrets-policy>

    <step n="0" name="Provision external infra">

      <supabase>
        <what>Existing project "usemount.dev" adopted (human had created it).
          ref=agyiylncvchzifuzvnew, org "itsmartyhimself"
          (id eafehnagwezbnfxclrvs), region eu-west-1, Postgres 17,
          url https://agyiylncvchzifuzvnew.supabase.co</what>
        <how>Located + configured via the Supabase Management API
          (api.supabase.com/v1, Bearer PAT): GET /organizations + /projects to
          find it; GET /projects/{ref}/api-keys?reveal=true for keys; PATCH
          /projects/{ref}/config/auth for uri_allow_list and to enable GitHub.</how>
        <keys>Project exposes BOTH legacy JWT keys (anon, service_role) and the
          new system (publishable/secret). Legacy anon + service_role chosen
          for the env contract (matches @supabase/ssr docs + RLS/JWT reasoning
          for PR2); new keys remain available as alternates.</keys>
        <auth>GitHub OAuth provider ENABLED, wired to the usemount.dev GitHub
          App's client_id/client_secret. Deliberate identity seam: one GitHub
          App is both the repo-access app and the Supabase GitHub sign-in
          provider, so the GH numeric user id stored as
          oauth_identities.provider_user_id (PR2) equals the App installation
          account.id matched in Step 3.</auth>
        <deferred>Google OAuth provider is CONFIGURED-PENDING-CREDENTIALS, not
          missed scope: it needs a Google Cloud OAuth client (separate console
          setup, outside this CLI). Deferred to PR2 per plan.</deferred>
        <notes>DB password is not API-retrievable and not needed: PR2 migrations
          apply via Management API POST /projects/{ref}/database/query; apps use
          @supabase/supabase-js (URL+keys), not raw Postgres. The Supabase↔git
          integration the human attempted is intentionally NOT used.
          supabase/config.toml (minimal, project_id) and
          supabase/migrations/.gitkeep committed; 0001_init.sql lands in PR2.</notes>
      </supabase>

      <github-app>
        <what>name="usemount.dev", slug="usemount-dev", app_id=3758221,
          owner="itsmartyhimself" (GH user id 259984339),
          html_url=https://github.com/apps/usemount-dev. Permissions
          contents/metadata/pull_requests:read. default_events=["push","repository"].</what>
        <how>GitHub App Manifest flow via a one-shot local helper
          (/tmp/usemount-ghapp-helper.mjs, Node built-ins only, never committed,
          deleted after handoff): served localhost:7654, auto-POSTed the
          manifest to github.com/settings/apps/new, exchanged the redirect code
          at POST /app-manifests/{code}/conversions.</how>
        <gotcha>First attempt rejected: "Default events unsupported:
          installation_repositories". installation / installation_repositories
          are GitHub-App lifecycle events delivered to every app AUTOMATICALLY
          and are invalid in manifest default_events — removed. The Step 3/4
          handler still receives them by virtue of being a GitHub App.</gotcha>
        <urls>hook_attributes.url, callback_urls, setup_url were baked into the
          manifest with the REAL provisioned URLs (webhook →
          api-production-5f25.up.railway.app/github/webhook; callback_urls
          include the Supabase /auth/v1/callback provider seam + localhost +
          Railway web; setup_url → Railway web /connect) — no post-creation
          PATCH needed.</urls>
        <secrets>client_secret, webhook_secret, RSA private key live ONLY in
          apps/api/.env.local (PEM base64 as GITHUB_APP_PRIVATE_KEY_BASE64) +
          Railway api service vars.</secrets>
      </github-app>

      <railway>
        <what>Project "usemount.dev" (9701c2f7-37fb-4870-b42d-d2998d3188d9),
          env "production" (27c2b720-a36f-4af7-8c0a-bb283f3878de). Services from
          itsmartyhimself/usemount.dev @ main: web
          (87da2e75-4087-4d60-8f2a-b646994bb73a) →
          web-production-18dfa1.up.railway.app; api
          (aa6be9e8-9d70-48f8-805f-70230594f768) →
          api-production-5f25.up.railway.app</what>
        <how>Public GraphQL API (backboard.railway.com/graphql/v2, Bearer team
          token): projectCreate(isMonorepo:true) → serviceCreate(source:{repo})
          ×2 → serviceInstanceUpdate ×2 → serviceDomainCreate ×2 →
          variableCollectionUpsert ×2. Token is team-scoped (cannot query `me`
          or GitHub-account state) so repo access was confirmed only by a
          successful serviceCreate — it succeeded, no extra user grant needed.</how>
        <config>Both: rootDirectory="/" (pnpm workspace needs repo root),
          region=europe-west4 (closest to Supabase eu-west-1). web build="pnpm
          install --frozen-lockfile &amp;&amp; pnpm --filter @usemount/shared
          build &amp;&amp; pnpm --filter @usemount/web build", start="pnpm
          --filter @usemount/web start"; api same shape with @usemount/api +
          healthcheckPath="/health".</config>
        <gotcha>An initial command set used filters "web"/"api" which do NOT
          match the scoped package names @usemount/web / @usemount/api;
          corrected via a second serviceInstanceUpdate. Always filter by the
          scoped name.</gotcha>
        <deploy-debt>Green deploy intentionally NOT chased in PR1 (gate = local
          boot + infra exists). variableCollectionUpsert used skipDeploys:true
          (code not on main yet); first deploy iterates when PR1 reaches main.
          CI/deploy hardening deferred to the first .github/workflows/* (none
          today) per plan Step 0.5.</deploy-debt>
      </railway>

      <env-contract>
        <what>apps/api/src/index.ts loads .env.local (cwd) else platform env
          (Railway), then fail-fasts on any missing of: SUPABASE_URL,
          SUPABASE_SERVICE_ROLE_KEY, GITHUB_APP_ID, GITHUB_APP_CLIENT_ID,
          GITHUB_APP_CLIENT_SECRET, GITHUB_APP_WEBHOOK_SECRET,
          GITHUB_APP_PRIVATE_KEY_BASE64. PORT respects Railway's injected value
          (local default 4000).</what>
        <committed>apps/web/.env.example + apps/api/.env.example (key names
          only). .gitignore gained *.pem.</committed>
      </env-contract>
    </step>

    <step n="1.5" name="Pre-migration cleanup">
      <item>/playground returns notFound() when NODE_ENV==="production"
        (verified no page/route files under app/playground/specimens — they are
        imported, not routed).</item>
      <item>app/[workspace]/[repo]/[branch]/page.tsx is now an async server
        component awaiting the Next 16 Promise params, dev-only logging them,
        passing them to AppShell via a new OPTIONAL prop (AppShellInstance /
        AppShellProps exported from app-shell + index.ts). No fetch; behavior
        unchanged when the prop is absent. Live fetch deferred to Step 3; TODO
        keeps its ROADMAP §Sidebar citation.</item>
      <item>"Initial task research + app shell layout.md" moved to
        docs/archive/; CLAUDE.md reference repointed and reworded.</item>
      <item>Empty-state secondary CTA (linked to /playground → now a prod 404)
        removed, replaced with one TODO comment citing migration-plan Step 1.5 /
        dashboard-build-plan Open Decision #2. Primary CTA + tokens untouched.</item>
    </step>

    <verification gate="PR1" result="PASS">
      <check>pnpm install --frozen-lockfile: lockfile unchanged (Step 0 added
        zero npm deps).</check>
      <check>apps/api booted :4000, env validation passed, GET /health →
        {"ok":true}.</check>
      <check>pnpm --filter @usemount/web build: success, TypeScript clean, 7/7
        pages; instance route correctly became dynamic.</check>
      <check>next start (production): /playground → 404; /login, /, /connect,
        /:workspace/:repo/:branch → 200.</check>
      <check>Both .env.local git-ignored; git status clean of secrets.</check>
      <operational-note>A pre-existing unrelated dev server held :3000 during
        the boot test, so web was validated via the production-build path; the
        cleanup pkill may have also stopped a human-owned concurrently-based
        `pnpm dev` (trivially restarted).</operational-note>
    </verification>

    <handoff>Generated credentials (Supabase URL/keys, GitHub App
      id/client/secret/webhook/PEM, Railway URLs) delivered to the human in
      chat and written only to gitignored .env.local + Railway service vars.
      /tmp helper + creds files deleted after handoff.</handoff>

    <next>PR2 (Step 2): supabase/migrations/0001_init.sql (8 tables per
      architecture-brief §2 + build_duration_ms + component_views + RLS +
      signup triggers), move ComponentManifest → @usemount/shared, install
      @supabase/supabase-js, OAuth wiring, re-wire demo hooks, delete demo
      data. Apply migration via Management API database/query. Enable Google
      provider once a Google Cloud OAuth client exists.</next>

    <correction pr="2" date="2026-05-18">The PR1 &lt;auth&gt; "Deliberate
      identity seam: one GitHub App is both the repo-access app and the
      Supabase GitHub sign-in provider" is NOT viable and was corrected in PR2.
      Supabase's stock `github` provider expects a GitHub **OAuth App**; a
      GitHub **App**'s client_id/secret completes token exchange but fails the
      subsequent profile/email fetch (`error=server_error`,
      `unexpected_failure`, "Error getting user profile from external
      provider") — a GitHub App has no OAuth-App user/email scope semantics and
      PR1's manifest requested no email permission. PR2 resolution: created a
      dedicated GitHub **OAuth App** "usemount.dev sign-in" (callback
      https://agyiylncvchzifuzvnew.supabase.co/auth/v1/callback), wired its
      client_id/secret into Supabase via Management API PATCH /config/auth. The
      GitHub App usemount-dev (app_id 3758221) is retained SOLELY for repo
      access (Step 3) — it is no longer the Supabase provider. Step 3's
      matching seam is PRESERVED: `GET /user` returns the same numeric id for
      the person via either app (verified live in B8#5: id 259984339 == the
      PR1-recorded App-owner id), so oauth_identities.provider_user_id still
      equals the installation account.id matched in Step 3. Security: the old
      GitHub App client_secret was exposed in the PR2 session transcript (an
      auth-config response dump) and must be rotated (GitHub App settings → new
      client secret → update apps/api/.env.local GITHUB_APP_CLIENT_SECRET +
      Railway api var). It is no longer in the Supabase provider (overwritten
      by the OAuth App secret), so no Supabase update is needed for that
      rotation.</correction>
  </pr>

  <pr id="2" branch="feat/migration-step-2" base="staging" covers="Step 2"
      status="complete" verified="true" date="2026-05-18">

    <secrets-policy>No secrets recorded in repo. PR2-exposed secrets (OAuth App
      secret, old GitHub App client secret) were ROTATED by the human in-session;
      the Supabase PAT used for the migration was deleted. apps/web/.env.local +
      apps/api/.env.local (gitignored) + Railway vars hold runtime secrets.</secrets-policy>

    <step n="2" name="Auth + Supabase schema/RLS/triggers + staged demo removal">
      <db>0001_init.sql (10 tables, RLS×10, 3 SECURITY DEFINER fns,
        on_auth_user_created trigger) authored and APPLIED to hosted DB via
        Management API POST /database/query. workspace_members policies use
        is_workspace_member/owner() helpers — non-recursive (RLS-recursion-safe).
        Verified live: a real GitHub sign-in produced 1 users
        (github_user_id=259984339), 1 personal workspace, 1 owner member, 1
        github oauth_identity, FK-consistent. Auth config PATCHed: site_url +
        uri_allow_list = localhost + Railway web (+ /auth/callback).</db>
      <types>ComponentManifest* + 10 dashboard types moved to @usemount/shared
        (manifest.ts/types.ts); old paths are re-export stubs (16 consumers
        unedited). Node16 → .js extensions in shared src/index.ts. Added
        @types/react devDep + optional react peer to packages/shared.</types>
      <web>@supabase/ssr + @supabase/supabase-js added. lib/supabase/
        {env,client,server,admin}.ts. proxy.ts (Next 16 renamed middleware→proxy,
        v16.0.0 — verified via build "ƒ Proxy" + per-request log). app/auth/
        callback/route.ts (exchangeCodeForSession, sanitized next). OAuth in
        login-screen.tsx (GitHub real; Google "coming soon", R1). Dashboard read
        path → Supabase: state.tsx + use-recent-repos + use-repo-search + new
        lib/dashboard/from-rows.ts mapper; nav-avatar server-prefetch. Signatures
        preserved. ?state= removed; EmptyState data-derived.</web>
      <demo-D3>Removed only DEMO_USER/DEMO_RECENT_REPOS/DEMO_NOW. DEMO_REPOS,
        PERSONAL_WORKSPACE, NOW, workspaceForRepo, synthesizeUnpinnedBranches,
        DEMO_WORKSPACES, DEMO_AVAILABLE_REPOS, DEMO_INSTALLATIONS, ACME_WORKSPACE,
        SYNTHETIC_* RETAINED — connect-flow + kept-helper consumers; die in
        PR3/Step 4. demo.ts NOT deleted (migration-plan "delete demo.ts after
        Step 2" is reinterpreted as the D3 staged path).</demo-D3>
      <gitignore-fix>.gitignore apps/*/lib/ wrongly ignored apps/web/lib (source);
        changed to apps/api/lib/ (only api emits build output to lib/). Latent
        since initial scaffold; surfaced because PR2 added the first new
        apps/web/lib files.</gitignore-fix>
    </step>

    <deviations>@supabase/ssr (D1, supabase-js alone can't persist server cookies
      Next 16). middleware→proxy (Next 16 v16.0.0). B7 executable subset (D3
      principle preserved; B8#8 grep clean). from-rows.ts added (dedupe row→shape
      ×3). env.ts literal process.env.NEXT_PUBLIC_* access (Turbopack only inlines
      literal form; dynamic access throws client-side). members:[] (sole consumer
      gates on kind==='team', never produced by trigger). config.toml github=true.</deviations>

    <correction-ref>PR1's "one GitHub App = Supabase sign-in provider" identity
      seam was non-viable (Supabase's stock github provider needs a GitHub OAuth
      App, not a GitHub App). PR2 created a dedicated GitHub OAuth App for
      sign-in; the GitHub App usemount-dev is now repo-access only. Seam intact:
      same numeric GH user id via both. See &lt;correction pr="2"&gt; above.</correction-ref>

    <verification>B8 all green: schema introspection; pnpm shared/api/web builds
      clean; pnpm dev boots; real GitHub sign-in→callback→session→dashboard;
      MANDATORY signup-trigger row check; fresh user→EmptyState; hooks resolve
      []; DEMO_/MOCK_USER grep clean in audited files; RLS non-recursive
      (structural); /login + dashboard visually identical. Post secret-rotation,
      sign-in re-verified working (incognito, code→307→/).</verification>

    <next>PR3 (Step 3): apps/api GitHub App backend (install-callback,
      installations list, repo-connections, repo branches, App-JWT auth helper,
      webhook lifecycle) + real connect-repo-form. Possibly 0002 migration for
      pending_installations (validate need first). Then Step 4 (build pipeline).</next>

    <known-risks>Railway hosted deploy of PR2 never run — first staging→main push
      is the first real hosted exercise of proxy.ts + new env. Google OAuth
      deferred (R1). Custom-domain coordinated pass still pending (GitHub App URLs
      + Supabase site_url + Railway NEXT_PUBLIC_API_URL).</known-risks>
  </pr>

  <pr id="3" branch="feat/migration-step-3" base="staging" covers="Step 3"
      status="complete" verified="paper-only" date="2026-05-19">

    <secrets-policy>No secrets in repo. apps/api/.env.local (gitignored) +
      Railway api vars hold GITHUB_APP_* + SUPABASE_*. PR3 added no new required
      env; GITHUB_APP_SLUG is optional (defaults usemount-dev). State CSRF reuses
      GITHUB_APP_WEBHOOK_SECRET via a domain-separation prefix — no new secret to
      provision/rotate. .env.example got the GITHUB_APP_SLUG comment only.</secrets-policy>

    <step n="3" name="GitHub App backend + real connect flow">
      <api>apps/api (Hono, Node16 → .js internal imports): env.ts (typed
        accessors), supabase/admin.ts (LAZY memoised service-role client),
        github/auth.ts (createAppAuth → App-JWT/installation Octokit, no token
        cache — 1h fresh), lib/require-user.ts (bearer verify via
        supabaseAdmin.auth.getUser + assertWorkspaceMember/Owner — authz in code
        since service-role bypasses RLS), lib/state-token.ts (HMAC install-state
        CSRF). Routes: GET /github/install-url, POST /github/install-callback,
        GET /github/installations (install-callback.ts); POST /repo-connections
        (default-pin main+feat/*+release/* as instance rows; Open Decision #4),
        GET /repo-connections/:id/branches (connections.ts); POST /github/webhook
        (webhook.ts). Mounted in index.ts; /health stays open.</api>
      <webhook>HMAC x-hub-signature-256 over RAW body (c.req.text() then
        JSON.parse), length-checked timingSafeEqual, 401 before parse. Handles
        installation_repositories.removed / repository.archived /
        repository.renamed → active=false / org_repo rename (architecture-brief
        §11's literal 3 events). push→build_jobs is Step 4.</webhook>
      <web>lib/api/client.ts (bearer-attaching fetch + connectApi). connect-repo-
        form rewired: real workspaces (Supabase) + repos (installations/
        install-callback) + first-time "Install GitHub App" CTA + submit → POST
        /repo-connections → router.push(redirect). app/(dashboard)/connect/
        callback/route.ts (sanitises GitHub redirect → /connect). step-select-
        repo / step-assign-workspace on real data. lib/dashboard/use-instance-
        branches.ts replaces MOCK_INSTANCE in sidebar-header-zone (trail/branch
        from useParams, branches from api, MOCK fallback off-route).
        [workspace]/[repo]/[branch]/page.tsx adds the RLS instance fetch +
        manifest count, threaded via additive optional AppShellInstance fields.</web>
      <demo-D3>DEMO_AVAILABLE_REPOS + DEMO_INSTALLATIONS removed (PR3 orphaned
        them). DEMO_REPOS / workspaceForRepo / synthesizeUnpinnedBranches + their
        transitive deps (PERSONAL_WORKSPACE/ACME_WORKSPACE/DEMO_WORKSPACES/NOW/
        SYNTHETIC_*) RETAINED — still feed the mock dashboard/sidebar list; die
        with the registry rewire in Step 4.3. demo.ts header refreshed.</demo-D3>
    </step>

    <deviations>web→api auth seam = bearer (session.access_token); plan never
      specified. Literal :userId path param DROPPED (IDOR — user derived from
      verified token). NO 0002 migration: R3 resolved — the app is auth-gated so
      the session is the authoritative identity; oauth_identities/account.id
      match only holds for personal installs (org account.id = org id), so
      pending_installations solves the wrong problem for v1. useInstanceBranches()
      takes no repoId + lives in lib/dashboard/ (R8 — migration-plan/ROADMAP
      apps/web/hooks/ + (repoId) are stale; call site only has slugs). install-
      callback.ts hosts 3 connect routes + new connections.ts split (plan listed
      3 filenames; mutation/discovery kept apart). supabaseAdmin is a LAZY
      factory not an eager const — eager top-level createClient ran during ESM
      import eval, before index.ts process.loadEnvFile, crashing boot (caught in
      paper-gate; web admin is also a factory). @octokit/webhooks skipped — node
      crypto.timingSafeEqual (fewer deps). Octokit auth-app@8/rest@22, supabase-
      js@2.105.4 (matches web), zod@4; caret + minimumReleaseAge resolved
      clean. AppShellInstance extended (optional/additive) — fetch seam only,
      consumer is Step 4.3.</deviations>

    <authz-fixes>Two holes caught by /advisor mid-review, fixed + re-verified:
      (1) install-callback now verifies a User-type installation's account.id ==
      users.github_user_id (the migration-plan/PR2 seam — a user-bound state
      token alone did NOT prove the user owns that installation_id). (2) /repo-
      connections refuses (409) if the (install,repo) already belongs to another
      workspace — the UNIQUE excludes workspace_id, so a bare upsert would
      silently re-home a connection (cross-workspace claim).</authz-fixes>

    <verification>PAPER-ONLY by human decision (no Railway deploy, no hosted
      webhook — R7/R9 deferred to the custom-domain coordinated pass). Green:
      shared/api tsc -b; web tsc --noEmit; web next build (/connect, /connect/
      callback, ƒ Proxy present); apps/api clean boot ({"ok":true}, lazy client,
      REQUIRED_ENV gate); installations/install-callback/repo-connections w/o
      bearer → 401; webhook no-sig→401, bad-sig→401, valid-sig+unhandled→200,
      valid-sig+tampered-body→401 (raw-body bound); state-token valid/tampered/
      empty/garbage all correct; App-JWT authenticates to real GitHub as
      usemount-dev/3758221 (PEM+appId env correct). NOT exercised (deferred):
      hosted webhook delivery, real install→connect→dashboard→branch→uninstall
      round-trip (needs GitHub App Setup/Webhook URLs = R9 + api reachable = R7).</verification>

    <known-risks>R1 two-app footgun stands (apps/api uses ONLY the GitHub App).
      R7 Railway api never deploy-verified — first staging→main is its first
      hosted run of the new routes/proxy. R9 GitHub App Setup URL (→ web /connect/
      callback) + Webhook URL (→ api /github/webhook) still unset; apps/api
      cors() is wide-open '*' — tighten with R9. NEW: Org/Enterprise install
      ownership is UNENFORCED — a signed-in user who learns an org's
      installation_id can list its repos and first-time-claim an unclaimed
      (install,repo) into their own workspace (cross-workspace re-home is blocked;
      first claim is not). Step 4 must gate via GitHub org-membership
      (session.provider_token /user/memberships or stored OAuth token). NEW:
      installation event action=deleted (full uninstall) is NOT handled — only
      installation_repositories.removed; whole-account uninstall leaves
      connections active=true. Add to the lifecycle handlers before go-live.
      Pre-existing: branch-with-slash breaks the single [branch] segment
      (redirect to default branch sidesteps it); slug URL scheme
      (workspace.name.toLowerCase()/orgRepo half) is non-unique but v1-safe (one
      personal ws/user, Google deferred); `pnpm lint` (eslint .) fails on
      nav-avatar.tsx (PR2 file, untouched) because @next/eslint-plugin-next is
      absent — next build is the real gate, this is environmental not PR3.</known-risks>

    <next>Step 4 (build pipeline — STOP per handoff): 4.0 spike, 4.1 push
      webhook → build_jobs, 4.2 worker loop, 4.3 registry/AppShell rewire (DEMO_
      REGISTRY / sidebar-panel-provider / canvas-stage / iframe + the retained
      demo.ts helpers die here). Address the two NEW known-risks in Step 4.
      Custom-domain coordinated pass (R9) + first hosted deploy (R7) outstanding.</next>
  </pr>

  <pr id="4" branch="feat/migration-step-4" base="staging"
      covers="Step 4.0 spike + the two PR3 security fixes"
      status="complete" verified="paper+spike-live" date="2026-05-19">

    <secrets-policy>No secrets in repo. PR4 added NO new required env and no new
      secret to provision/rotate. The webhook secret read for the fix-2 paper
      test was loaded from gitignored apps/api/.env.local and never printed.
      Spike is hermetic (no Supabase/Storage/Railway/GitHub clone/PAT). Spike
      output (manifests) written only to /tmp/usemount-spike (not committed).</secrets-policy>

    <decisions>The product owner delegated all four open decisions to the
      agent+advisor ("I'm just the product designer; do the research").
      Resolved: (1) Fix-1 strategy = (C) HARD-DENY Org/Enterprise installs in
      v1. The advisor recommended the canonical (A') "Request user authorization
      during installation" but it needs a GitHub-App settings toggle + OAuth
      callback the owner explicitly cannot operate; (C) REMOVES the attack
      surface instead of guarding it with infra nobody can manage, matches PR3's
      already-stated "personal installs are the v1 seam", and the dogfood target
      (itsmartyhimself/usemount.dev) is a User account. (A') is the documented
      post-cutline upgrade for org self-serve. (2) Introspection = run BOTH
      react-docgen-typescript and ts-morph head-to-head on Button (Open Decision
      #1's named experiment), rdt primary for the sweep. (3) Fix-1 sequencing =
      moot under (C): zero human config, paper-verifiable in PR4 like PR3.
      (4) Spike = hermetic dogfood-only; report states a real customer-codebase
      pass remains REQUIRED before 4.2 (no overclaim).</decisions>

    <audit-findings step="0a">PR3 re-audited fresh (security+setup). CONFIRMED
      SOUND: webhook HMAC hashes the raw c.req.text() bytes, length-checks
      before timingSafeEqual, 401s before JSON.parse (read + live-reconfirmed);
      supabaseAdmin().auth.getUser is the sole trust root and every authed route
      carries requireUser + assertWorkspace*; state-token has the
      domain-separation prefix, 10-min TTL, +60s skew clamp, timing-safe compare
      — the GITHUB_APP_WEBHOOK_SECRET reuse is acceptable (one-way HMAC, distinct
      namespace), NOT "fixed"; Node16 .js extensions everywhere, apps/api/lib
      gitignored with the apps/web/lib SOURCE caveat, .env.example honest, lazy
      memoised supabaseAdmin (no eager module-load client). cors() is wide-open
      '*' (R9) — left as-is, needs final domains. The two PR3 known-risks
      reproduced exactly → became the two fixes. NEW MATERIAL FINDING (advisor-
      confirmed): /repo-connections has the SAME ownership gap as
      install-callback — its 409 only blocks RE-HOME of an already-existing
      (install,repo) row, never the FIRST claim, so a direct POST bypasses an
      install-callback-only gate. Fix 1 therefore had to be a shared helper on
      BOTH routes. CORRECTION TO HANDOFF: `installation` /
      `installation_repositories` are GitHub-App lifecycle events delivered to
      EVERY app automatically (PR1 &lt;gotcha&gt;) — fix 2 fires in production
      with NO App-config change; the handoff's "add installation events to the
      subscription set" is a phantom R9 item, do not chase it.
      installation.suspend/unsuspend (softer, reversible) intentionally NOT
      handled — tracked.</audit-findings>

    <security-fixes>
      (1) Org/Enterprise ownership: new apps/api/src/github/installation-
      ownership.ts exports assertInstallationOwnership(userId, installationId) —
      getAppOctokit().apps.getInstallation → unknown/stale id 404; account.type
      !== "User" (Organization, or Enterprise = no `type` field) 403 "not
      supported yet"; User install verified account.id == users.github_user_id
      (the PR2-correction seam), else 403. Called by install-callback.ts
      (replaces the old inline User-only block; now runs BEFORE listInstallRepos
      so no repo disclosure precedes the ownership proof) AND by connections.ts
      POST /repo-connections (after assertWorkspaceOwner — closes the first-claim
      gap). getAppOctokit import dropped from install-callback (helper owns it).
      (2) installation.deleted: webhook.ts gained deactivateAllForInstall(id)
      (UPDATE repo_connections active=false WHERE github_install_id=id, no
      repo-list) + an `event==="installation" &amp;&amp; action==="deleted"`
      dispatch branch after repository.renamed, before the final 200. Raw-body-
      HMAC-before-parse contract untouched (branch is post-verify+parse).</security-fixes>

    <spike-results script="apps/api/scripts/spike.ts" run="pnpm --filter @usemount/api spike">
      HERMETIC, ran live against this repo's apps/web/components/live (the
      dogfood target — no external customer codebase exists here). CONCRETE
      METRICS: 41 components; 41/41 esbuild-bundled OK; 27/41 introspected
      (props&gt;0). Button: rdt auto-derived controls that match the
      hand-authored button.manifest.tsx 1:1 (variants 6 / sizes 3 / forms 2 /
      booleans 3) AND additionally auto-detected an `icon: ReactNode` slot the
      hand-authored manifest never declared — auto-introspection ≥ hand-authored,
      a concrete Step-5 override-design signal. From TypeScript types alone, zero
      manifest file — the core "auto-manifest path works" proof. OPEN DECISION
      #1 head-to-head: rdt 14 props ~520ms AND ts-morph 14 props BOTH resolve
      ButtonProps cross-file (it lives in button.config.ts) through
      forwardRef&lt;ButtonProps &amp; AriaAttributes &amp; DataAttributes&gt; and
      surface the union literals; rdt is purpose-built/less-code but REQUIRES a
      node_modules propFilter to tame the aria-*/data-* blow-up, ts-morph needs
      no taming but you hand-walk forwardRef→props → rdt PRIMARY, ts-morph the
      precise fallback for the limited-introspection bucket. Sweep wall 26s
      (single process, no clone, 41 × rdt + 2× esbuild raw/min). Bundle: total
      minified ~13.7MB, avg ~334KB; DS primitives small (icon-button 27KB,
      workspace-chip 27KB min) but app-shell-class files are 1–2MB min
      (app-shell 1.9MB, sidebar-panel 1.8MB) → per-component + shared-deps-graph
      + source_hash diff-only rebuild is MANDATORY not optional. Failure-mode
      histogram (overlapping, architecture-brief §3): clean 18, limited-
      introspection 14, no-use-client/rsc? 12, provider/context 4, routing-hooks
      3, build-fail 0. MANIFEST-SHAPE DUALITY (primary re-plan input):
      @usemount/shared ComponentManifest&lt;P&gt;.render:(props)=&gt;ReactNode is
      an in-host RENDER-side concept; the pipeline emits METADATA + a bundle
      artifact_url and the iframe (4.3) supplies render. The spike emits the DB
      component_manifests COLUMN shape, not ComponentManifest. Re-plan adds a
      build-side type to @usemount/shared (NOT done in PR4 — read-only there);
      paste-ready BuildManifest printed by the spike. GO/NO-GO: the rdt+esbuild
      tooling HOLDS for a 41-component Tailwind-v4 DS. It does NOT validate the
      700-person Persona-C case — a real customer-codebase pass remains REQUIRED
      before 4.2 commits (architecture-brief §3).</spike-results>

    <deviations>New file installation-ownership.ts (handoff said "modify
      install-callback.ts"; a shared helper on BOTH install-callback AND
      connections.ts was required to actually close the hole — advisor-confirmed
      — and is cleaner than duplicating). (A')→(C) for fix 1 (owner delegated;
      cannot operate the GitHub-App toggle the advisor's recommended (A')
      needs — (C) was the advisor's own named retreat; flagged to the advisor at
      the done-gate, not a silent switch). Spike lives at apps/api/scripts/ —
      NOT in tsc -b (tsconfig rootDir=src), runs via tsx; correct, it is tooling
      not runtime. devDeps esbuild@0.28.0 / react-docgen-typescript@2.4.0 /
      ts-morph@28.0.0 added to apps/api (esbuild was in root
      onlyBuiltDependencies but a dependency nowhere — adding expected per R5;
      caret + minimumReleaseAge resolved ≥7-day clean). ts-morph probe upgraded
      to checker-resolve through forwardRef + the cross-file alias so the
      head-to-head is honest, not a strawman.</deviations>

    <verification>Builds GREEN: @usemount/shared tsc -b; @usemount/api tsc -b
      (incl. new helper + modified webhook/install-callback/connections); web
      tsc --noEmit; web next build (9 routes, ƒ Proxy present, /connect +
      /connect/callback intact). Fix 2 (apps/api booted :4123, fake install id
      999999999999 → UPDATE matches 0 rows, ZERO prod mutation): signed
      installation.deleted→200 {ok:true}; bad-sig→401; no-sig→401; tampered-
      body→401 (raw-body bound); regression installation_repositories.removed
      →200. Fix 1: install-callback &amp; repo-connections no-bearer→401
      (requireUser gate on both helper call sites); helper LIVE-exercised —
      nonexistent installation_id → real GitHub App-JWT GET /app/installations
      → 404 → HTTPException 404 "Installation not found". The org-deny and
      User-mismatch branches are pure logic on the getInstallation response and
      are code-traced (no real org installation is obtainable paper-only; PR3
      precedent). Spike: live metrics above. NOT exercised (R7/R9, owner choice
      — same as PR3): hosted webhook delivery, real install→connect round-trip,
      Railway deploy. Operational: a stale prior-session background dev-server
      pair ("sign-in check"/"sign-in test") failed when the :4123 teardown pkill
      ran — incidental, trivially restarted; PR4 made ZERO web changes (mirrors
      PR1's pkill note).</verification>

    <known-risks>R1 two-app footgun stands (apps/api uses ONLY the GitHub App).
      R7 apps/api never deploy-verified — first staging→main is its first hosted
      run. R9 cors '*' + GitHub App Setup/Webhook URLs unset (but fix 2 needs NO
      new App event subscription — corrected above; do not chase it). NEW:
      Org/Enterprise installs are now HARD-DENIED in v1 (the hole is closed by
      removing the surface, not guarding it); the (A') OAuth-on-install upgrade
      is the documented path when org self-serve is needed (post-cutline,
      owner-owned GitHub-App settings). installation.suspend/unsuspend not
      handled (reversible state) — tracked. NEW Storage still unprovisioned
      (hard dep for 4.2/4.3, NOT the spike). mount.config.ts execution = RCE on
      the build worker and the iframe = the crown-jewel surface — binding
      4.2/4.3 design constraints (parse mount.config statically via ts-morph AST,
      NEVER import()/eval; iframe sandbox=allow-scripts WITHOUT allow-same-origin
      + separate origin + strict CSP + narrow postMessage). Spike go/no-go:
      validates tooling on the dogfood DS only — a real customer-codebase pass
      is REQUIRED before 4.2. Pre-existing unchanged: branch-with-slash vs single
      [branch] segment; non-unique slug scheme (v1-safe); `pnpm lint` fails on
      PR2's nav-avatar.tsx (missing @next/eslint-plugin-next) — next build is the
      real gate.</known-risks>

    <next>Refined Step-4 plan, informed by the spike (STOP here per handoff —
      4.1+ NOT started). Provision Supabase Storage FIRST (blocker for 4.2/4.3;
      needs the NEW Supabase PAT — R2 — request from the owner, session-only).
      4.1 push-webhook → build_jobs: HMAC reuse of the verified webhook.ts path;
      MUST add per-(instance, head_sha) dedup + rate-limit — spike shows a build
      is cheap (~0.3–1.5s/component) so amplification, not build cost, is the
      DoS (HMAC proves "from GitHub", not "reasonable volume"). 4.2 worker
      (FOR UPDATE SKIP LOCKED lease, 10-min reclaim): FIRST add the paste-ready
      BuildManifest to @usemount/shared (render-side ComponentManifest&lt;P&gt;
      stays for the iframe→host contract); rdt primary + ts-morph fallback for
      the 14/41 limited-introspection bucket; per-component esbuild on a shared
      deps graph; source_hash diff-only rebuild is mandatory (1–2MB shell files);
      parse mount.config.ts via ts-morph AST, never import()/eval (RCE);
      ephemeral tmpfs, no customer postinstall; upload bundles→Storage, upsert
      component_manifests. 4.3 iframe runtime + preview/[manifestId] route:
      separate origin, sandbox=allow-scripts WITHOUT allow-same-origin, strict
      CSP, narrow typed postMessage; the 12/41 no-use-client + 4/41 provider +
      3/41 routing-hooks buckets scope the iframe context-shim (router/theme/
      provider auto-detect = Step 5); replace manifest.render with iframe mount;
      DEMO_REGISTRY / sidebar-panel-provider / stage-content rewire + the
      retained demo.ts helpers die here. 4.4 Realtime stale-viewer. Step 5:
      failure-mode dispositions (spike already classifies them), support-matrix
      connect gate, every-2h reconciler. R7/R9 coordinated pass + Storage
      provisioning + a real customer-codebase spike pass all precede 4.2
      go-live. Org support via (A') when org self-serve is needed.</next>
  </pr>

  <addendum to="4" name="Step 4.0b — real customer-codebase spike pass"
      branch="feat/migration-step-4.0b" base="staging" date="2026-05-19"
      verified="spike-live">
    <secrets-policy>Still hermetic — reads a checked-out tree on disk, no
      Supabase/Storage/Railway/clone/PAT. Target repo (REV Plugin) is the
      product owner's own local checkout (github.com/itsmartyhimself/REV-plugin);
      no credentials touched. Spike output → /tmp/usemount-spike/&lt;label&gt;/
      (not committed).</secrets-policy>

    <what>Closes the PR4 &lt;next&gt; pre-4.2 blocker "a real customer-codebase
      spike pass". spike.ts generalized via argv [repoRoot] [componentsRelDir]
      [tsconfigRelPath] [label] (no args = dogfood, backward-compatible); the
      one-entry-per-subdir walk became a recursive *.tsx collector (works for
      flat repos like REV Plugin's components/ui/*.tsx as well as dir-per-
      component); esbuild alias base + tsconfig now derive from the target;
      Open-Decision-#1 head-to-head runs dogfood-only (settled in PR4). NOTE the
      deeper recursive walk re-counts the DOGFOOD as 79 components / 50
      introspected / 79 bundled / 40.7s — that is a STRICTLY DEEPER measurement
      than PR4's 41-one-per-dir snapshot, not a contradiction; PR4's 41 numbers
      stand as that snapshot.</what>

    <rev-plugin-result>Target: REV Plugin (React 19 ✓, TS 5 ✓, but Next 15 ✗
      &amp; Tailwind v3 ✗ — OUT of the v1 bounded support matrix; it would be
      refused at connect, which is correct and proves the Step-5 #6 support-gate
      is load-bearing). The TOOLING is matrix-independent and ran clean: 29
      components, 29/29 esbuild-bundled (REV's own Radix/lucide/framer deps
      resolved from its node_modules), 24/29 introspected, 11.6s single-process
      (rdt + raw+min esbuild), total ~2.95MB min / avg ~102KB, failure-mode
      histogram clean 13 / no-use-client(rsc?) 10 / limited-introspection 5 /
      provider-context 2, ZERO build-fail. Decisive: the pipeline is codebase-
      AGNOSTIC — a completely different external repo (different conventions,
      flat layout, Radix-based) worked with zero code change beyond argv.</rev-plugin-result>

    <go-no-go>GO for the Step-4 build architecture (architecture-brief §319
      gate). Per-component cost measured on TWO real codebases ≈ ~0.4s
      (rdt+raw+min). The "~0.4s × 700 ≈ ~5min first sync" figure is a FERMI
      estimate, CEILING-UNCERTAIN, NOT comfortably under the §319 5-min
      threshold: (a) a real 700-component tree has a proportional tail of
      app-shell-class 1–2MB files, so a linear mean understates first sync;
      (b) esbuild parallelism was NOT exercised (sequential single-process) —
      parallelized this is ≪1min, a heavy/exotic tsconfig grows it. What
      actually makes steady-state safe is the per-component source_hash
      diff-only rebuild (only changed components rebuild after first sync) — NOT
      the first-sync number. No worker farm needed for v1; first-sync cost is
      the only scale risk and it is bounded by diff-only rebuild + optional
      esbuild parallelism.</go-no-go>

    <new-blockers source="advisor-calibrated">
      (1) PROP-FILTER HOLE (4.2 design constraint, NOT a customer override
      case): REV's ui-animate-ui-slot returned 274 props — a customer component
      re-exporting a Radix Slot type; the node_modules propFilter does NOT catch
      a *customer-authored* file that re-exports a large base type. Hit 1/29
      (3.4%) on the FIRST external repo. Persona C will not hand-write 30
      canvas.config overrides — the 4.2 build worker MUST handle this in-tooling
      (cap returned-prop count / detect intersection-with-large-base-type /
      ts-morph fallback for these). Re-plan 4.2 scope must include this BEFORE
      4.2 ships, not Step-5-after.
      (2) INTROSPECTION-RATE QUALITY (product-quality finding the owner must
      hear): 83% (REV) / 63% (deeper dogfood) introspected → ~17–37% of real
      components render but with an EMPTY controls/properties panel. The product
      promise survives ("every client component renders") but a meaningful
      fraction are variant-toggle-less in v1. Step 5 must explicitly own
      "raise the introspection rate", or v1 ships accepting that fraction.</new-blockers>

    <pre-4.2-checklist>Closed by 4.0b: the real customer-codebase pass. STILL
      OPEN before 4.2: (i) Supabase Storage provisioning (needs the new
      session-only Supabase PAT — R2 — request when 4.2 starts, owner deletes
      after); (ii) R7/R9 coordinated pass (first hosted deploy + GitHub App
      Setup/Webhook URLs + CORS lock); (iii) the two new advisor-calibrated
      blockers above folded into 4.2 scope. 4.1+ still NOT started (handoff
      STOP honoured).</pre-4.2-checklist>
  </addendum>
</migration-log>

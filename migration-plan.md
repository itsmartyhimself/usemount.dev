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
</migration-log>

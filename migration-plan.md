# Migrate usemount.dev from demo to live (Steps 0 → 5)

## Context

The frontend is feature-complete at the UI/styling layer but runs entirely on hardcoded demo data. The architecture is fully locked in `architecture-brief.md` and `dashboard-build-plan.md` — an 8-step build sequence, Supabase + Railway + GitHub App, ephemeral builds, ts-morph-checker manifest generation (PR6 inverted PR4's rdt-primary default; rdt stays as cross-check). None of the external infra is provisioned, none of the backend is wired. The migration replaces demo data sources with live ones following the existing plan, with the cutline at **end of Step 5 (Robust MVP)** — a real repo connectable, real sync running, manifest auto-generation honest enough for the first two real clients (Persona A/C).

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
5. Run the **ts-morph checker** (PR6 D2 inversion — primary; rdt optional cross-check) on each component → emit a `BuildManifest` from `@usemount/shared` (build-side; the render-side `ComponentManifest<P>` is the iframe→host contract from Step 4.3).
6. Upload bundles to Supabase Storage; insert/update `component_manifests` rows with artifact URL + `source_hash`.
7. Update `instances.last_synced_commit_sha` and `last_synced_at`. Destroy sandbox.

**Step 4.3 — Iframe runtime + canvas wiring + sandbox hardening** (PR7-closed; D1=same-origin v1 + R9 cleanup, D2=delete `ComponentManifest<P>.render`, D3=15-min signed-URL TTL — see `<pr id="7">` in `<migration-log>` for the full delivery):
1. New `apps/web/app/preview/[manifestId]/route.ts` — serves a minimal HTML doc that mounts the bundle and supplies router + theme defaults per architecture brief §3. Strict CSP via response header with a per-request nonce on the inline importmap + bootstrap script (`script-src` is nonce-gated, no `'unsafe-inline'`).
2. **Iframe sandboxing is mandatory at this step, not later** (per `apps/web/ROADMAP.md` §Component rendering). The iframe element gets `sandbox="allow-scripts"` (no `allow-same-origin`). Response sets a strict CSP: `default-src 'none'; script-src 'self' 'nonce-<n>' https://<storage-host>; style-src 'self' 'unsafe-inline' https://<storage-host>; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`. Without this, a malicious customer component can reach host cookies/storage.
3. Replace `manifest.render(props)` in canvas/stage with iframe mount: `<IframeMount manifestId=... instanceId=... props=... />` element with `sandbox="allow-scripts"`, send props via versioned `postMessage` over a narrow protocol (typed message kinds: `init`, `setProps`, `ready`, `resize`, `error` — `packages/shared/src/iframe-protocol.ts`). Existing `controls` schema drives the variants/sizes/forms/booleans/slots panel; PR7 adds strings/numbers/handlers/objects row renderers per PR6 D1.
4. Replace `apps/web/components/live/sidebar-panel/sidebar-panel-provider.tsx` `DEMO_REGISTRY` source with a server-side Supabase query keyed on `instance_id` (`apps/web/lib/registry/from-supabase.ts` — produces both the sidebar tree shape and the per-leaf manifest map in one round-trip).
5. Append a `component_views` row each time a manifest mounts (the day-one telemetry from Step 2). RLS-gated by the existing `is_workspace_member` policy on `component_views.cv_ins`.
6. Delete `apps/web/lib/registry/data.ts` (DEMO_REGISTRY) + `manifests.ts` (buttonManifest) + `manifest-types.ts` (the re-export stub — D2 collapses ComponentManifest into `extends BuildManifest`, `render` field dropped) + `components/live/button/button.manifest.tsx`.
7. Self-host React as ESM in `apps/web/public/preview-runtime/{react,react-dom,react-dom-client,react-jsx-runtime}.mjs` (built by `apps/api/scripts/build-preview-runtime.ts`); the iframe's importmap aliases the externals PR6's `bundle.ts` leaves unresolved.

**Step 4.4 — Realtime stale-viewer**:
1. Replace `apps/web/components/live/app-shell/stale-viewer-trigger.tsx`'s 30s `setTimeout` with `supabase.channel('instance:${id}').on('postgres_changes', { table: 'instances', filter: 'id=eq.${id}' })` listening for `last_synced_commit_sha` changes.

**Verification**: connect this usemount.dev repo to itself. Push a button color change. Watch the dashboard show "syncing → synced" within a minute. Refresh and see the change. Open the same instance in a second tab, push another change → first tab shows the stale-viewer toast.

---

### Step 5 — Manifest auto-generation polish (medium)

Per `dashboard-build-plan.md` Step 5 + `architecture-brief.md` §11.

1. **Provider auto-detect**: build worker scans `app/layout.tsx` (or equivalent). If `ThemeProvider`, `QueryClientProvider`, `NextIntlProvider`, etc. wrap `{children}`, generate a `providers.auto.tsx` wrapper file in the bundle and apply it in the iframe runtime. Common providers covered: theme, react-query, next-themes, next-intl, jotai/zustand stores.
2. **`canvas.providers.tsx` fallback**: when present at customer repo root, build worker copies it into the bundle. Iframe wraps every component with it before render.
3. **`Component.canvas.tsx` override file**: per-component opt-in enrichment. If `Button.canvas.tsx` exists next to `Button.tsx`, its exported `controls` merge into / override the auto-generated manifest's controls. Document the surface in `docs/canvas-overrides.md`.
4. **Generics / discriminated unions**: under the PR6 checker engine, discriminated unions become typed read-only rows (every resolved prop appears in the panel — the D1 hybrid scope). Truly generic components (`DataTable<T>`) still emit `introspectionGap='generic'` for the unconstrained T; non-T props still resolve normally. Component renders + non-generic props show in the panel.
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

  <addendum to="4" name="Step 4.2-prep — Storage + foundational solo prep"
      branch="feat/migration-step-4.2-prep" base="staging" date="2026-05-19"
      verified="builds+spike-live">
    <secrets-policy>A fresh Supabase PAT was supplied by the owner for THIS
      session only, used solely to verify project access + list buckets via the
      Management API, then the owner deleted it. Bucket creation used the
      service_role key (already in gitignored apps/api/.env.local — the
      Management API has no bucket-create endpoint). Both secrets were staged to
      mode-600 /tmp files, never echoed, never written to any committed file or
      this log, and shredded (rm -P) immediately after provisioning. Only the
      non-secret bucket name appears here. NOTE this addendum was written before
      the owner-confirmed PAT deletion — the owner deletes it on done-report.</secrets-policy>

    <context>Post-PR4/4.0b, the owner chose: push staging→origin first (done —
      origin/staging 7d9d112→ad3f32a, the first push in this project; main
      untouched at 6d124e1, Railway watches main so NO hosted deploy was
      triggered), then do "Phase 1" = Storage + the foundational no-user prep,
      THEN clear context and write a fresh 4.2 handoff (same style as the
      PR2→PR3→PR4 handoffs) for the large 4.2 build. R7/R9 hosted cutover was
      explicitly kept OUT of Phase 1 as its own deliberate later go-live gate.</context>

    <solo-prep>
      (1) @usemount/shared gained build-manifest.ts: BuildManifest /
      BuildManifestControls / BuildManifestKind / IntrospectionGap, exported
      from index.ts (Node16 .js). This is the paste-ready resolution of the
      PR4 manifest-shape-duality finding — the BUILD-side contract the 4.2
      worker emits (metadata + artifactUrl), kept deliberately separate from the
      render-side ComponentManifest<P> (iframe supplies render at 4.3). Every
      field is commented with its public.component_manifests column.
      (2) spike.ts hardened + now CONSUMES the shared BuildManifest (proves the
      contract end-to-end): PROP_CAP=40 caps the 4.0b 274-prop Radix-Slot
      re-export blow-up BEFORE deriving controls (panel can't explode), flagged
      gap=large-base-type; classifyGap() records the honest IntrospectionGap per
      component; the report now prints the REAL product-quality number — RICH
      (≥1 control) — plus a gap histogram.
    </solo-prep>

    <introspection-truth source="spike re-run, both targets">RICH (component
      renders AND has ≥1 usable control) = ~33% dogfood (26/79) / ~34%
      REV-Plugin (10/29). The earlier "introspected 63%/83%" counted "has any
      prop at all" — RICH is the honest figure: ~2 of 3 real components would
      render with an EMPTY controls panel under v1 tooling. The product promise
      ("every client component renders") holds; the properties-panel richness
      does not, yet. REV-Plugin gap histogram: external-union 14 (DOMINANT —
      variant/size unions rdt can't read literals for), forwardref-unresolved 3,
      no-props-interface 2, large-base-type 1. external-union is THE lever for
      the 4.2 introspection-rate work. This is a v1 product-quality decision the
      owner now owns explicitly (raise the rate in 4.2/Step-5, or ship
      accepting the empty-panel fraction).</introspection-truth>

    <storage>Hosted private bucket `component-artifacts` created via the
      Storage API (POST https://&lt;ref&gt;.supabase.co/storage/v1/bucket,
      service_role) — public=false, file_size_limit=52428800 (50 MiB);
      verified by list. supabase/config.toml gained a documented [storage] +
      [storage.buckets.component-artifacts] block (local-stack parity + durable
      intent, mirroring how [auth] documents PR2's hosted PATCH). Holds the 4.2
      worker's per-component esbuild bundles, keyed by instance, referenced from
      component_manifests.artifact_url; PRIVATE by design (customer code, served
      via signed URLs / the 4.3 preview route — mirrors workspace-RLS
      isolation). 50 MiB is comfortable headroom (4.0b largest min bundle
      ~1.9 MB). No RLS/Storage policies added yet — the 4.2 worker writes with
      service_role (RLS-bypassing, same posture as the other tables); read-path
      policies/signing are 4.3 scope.</storage>

    <verification>Builds GREEN: @usemount/shared tsc -b (new build-manifest.ts),
      @usemount/api tsc -b, web tsc --noEmit. Spike re-ran live on BOTH targets
      with the shared BuildManifest + cap/gap: 79/79 &amp; 29/29 still bundle,
      274-prop case now shows 274! (capped, gap=large-base-type), RICH% + gap
      histogram emit correctly. Storage bucket existence verified via Storage
      API list (public=false, 50 MiB). PAT validity confirmed against
      GET /v1/projects. NOT done (deliberate): R7/R9 hosted cutover, any 4.1+
      build code.</verification>

    <pre-4.2-checklist>CLOSED now: real customer-codebase spike pass (4.0b);
      Supabase Storage provisioned (this addendum); BuildManifest contract +
      propFilter cap + introspection instrumentation (this addendum). STILL OPEN
      before 4.2 GO-LIVE (not before 4.2 dev): R7/R9 coordinated pass (first
      Railway deploy from main + GitHub App Setup/Webhook URLs + CORS lock) —
      its own deliberate gate. FOLD INTO 4.2 BUILD SCOPE: the introspection-rate
      work (external-union is the dominant gap), ts-morph fallback for
      large-base-type/forwardref-unresolved, mount.config static-parse (RCE),
      iframe CSP/sandbox (4.3). Next action per owner: clear context, then a
      fresh full-scope 4.2 handoff doc (worker queue-lease loop + 4.1
      push-webhook + 4.2 build/bundle/manifest-emit/Storage-upload + 4.3 iframe
      runtime + 4.4 realtime), minus everything closed above.</pre-4.2-checklist>
  </addendum>

  <pr id="5" branch="feat/migration-step-4.1" base="staging" covers="Step 4.1"
      status="complete" verified="builds+harness-live+boot-smoke" date="2026-05-20">

    <secrets-policy>No secrets in repo. A session-only Supabase PAT was supplied
      by the owner to apply 0002 (Management API only); staged to
      /tmp/usemount-sb-pat mode-600, never echoed back, never written to any
      committed file, shredded at hand-back. The owner deletes the PAT in the
      Supabase dashboard on done-report (R2). Harness writes sentinel rows
      (github_install_id=999_999_999_991, branches "test/pr5-*") to the live
      hosted DB and tears them down in a finally block — verified clean after
      the run (0 leftover_conns, 0 leftover_insts, 0 total build_jobs). The
      real GITHUB_APP_WEBHOOK_SECRET from apps/api/.env.local is the signing
      key for the harness payloads; it never leaves the local process.</secrets-policy>

    <decisions>
      (1) Dedup mechanism = DB-level via 0002 migration's UNIQUE partial index
      (owner-picked option A; advisor-recommended). Two concurrent identical
      (instance_id, commit_sha) INSERTs collide on the index — the second
      yields Postgres unique_violation (SQLSTATE 23505), which apps/api maps to
      `deduped`. Partial predicate = `status IN ('queued','running')` so a SHA
      that previously built (succeeded/failed/canceled) can rebuild on a new
      push. The index protects both the 4.1 write path and 4.2's worker
      re-enqueue path against duplicates.
      (2) Rate-limit = in-memory token bucket per `installation_id` (capacity
      10, refill 0.5/sec → ~30/min sustained, burst of 10). Resets on
      apps/api restart — accepted v1 footgun (worst case: attacker waits ~120s
      for a deploy to retry; real fast-pushers fit comfortably under the cap).
      Multi-replica → swap for Redis-backed counter; the `tryConsume(kind,
      key, cfg)` shape doesn't change.
      (3) Test harness = in-process via Hono's `app.request(...)` rather than a
      spawned subprocess + HTTP. Required a tiny refactor — extracting
      buildApp() from index.ts to src/app.ts — that's a strict improvement
      (testability + future integration tests for the 4.2 worker can also
      import the routed app without binding a port). index.ts still owns env
      validation + serve(); the .env.local load + REQUIRED_ENV gate are
      unchanged.
    </decisions>

    <audit-findings step="0a">Pre-PR5 audit of PR4 + 4.0b + 4.2-prep
      (paper/local-verified only) re-confirmed sound: webhook.ts raw-body HMAC
      hashed BEFORE JSON.parse, length-checked timingSafeEqual, 401 before
      parse, installation.deleted → deactivateAllForInstall; installation-
      ownership.ts hard-denies Org/Enterprise (account.type !== 'User'),
      verifies User account.id == users.github_user_id, 404 on stale install
      ids; the shared helper is called BEFORE listInstallRepos in
      install-callback.ts AND from connections.ts (closes the first-claim gap);
      state-token.ts domain-prefixed HMAC + 10-min TTL + 60s skew clamp;
      supabaseAdmin() is a lazy memoised factory (no eager top-level client);
      Node16 `.js` extensions everywhere; apps/api/lib gitignored, apps/web/lib
      NOT (correct); .env.local gitignored. cors() is still wide-open '*' (R9,
      intentional; do not fix). build-manifest.ts controls schema models only
      variants/sizes/forms/booleans/slots — cannot express string/number/
      handler/object → THE PR6-kickoff D1 question (panel-completeness scope).
      No drift, no holes, audit-clean.</audit-findings>

    <step n="4.1" name="push-webhook → build_jobs">
      <db>supabase/migrations/0002_build_jobs_dedup.sql — one CREATE UNIQUE
        INDEX, applied to the hosted DB via Management API POST
        /projects/agyiylncvchzifuzvnew/database/query (Bearer PAT). Verified
        live via pg_indexes: indexname=build_jobs_active_dedup_idx, definition
        CREATE UNIQUE INDEX ... USING btree (instance_id, commit_sha) WHERE
        (status = ANY (ARRAY['queued'::build_status, 'running'::build_status])).
        build_jobs was empty (0 rows) before apply so the migration ran with no
        data-prep work needed.</db>
      <code>
        New: apps/api/src/lib/rate-limit.ts (token bucket — generic over kind+
        key, test hook accepts a deterministic `nowMs`, exports
        `resetAllBuckets()` for the harness). New: apps/api/src/github/
        push-enqueue.ts (`enqueuePushBuilds(payload)` — branch-ref-only,
        deleted/zero-SHA skip, repo+install sanity match, fan-out over active
        repo_connections, pinned-only enqueue, 23505 → `deduped`, returns a
        discriminated PushEnqueueOutcome union per touched instance). New:
        apps/api/src/app.ts (extracted `buildApp()` for in-process tests).
        Modified: apps/api/src/github/webhook.ts (push branch after lifecycle
        dispatch; payload type widened with ref/before/after/deleted; logging is
        best-effort — deduped + non-anomalous skips silent). Modified:
        apps/api/src/index.ts (uses buildApp; env validation + serve unchanged).
        New: apps/api/scripts/verify-push-webhook.ts + pnpm script
        `verify:push-webhook`. Push event handling needs NO GitHub App config
        change (push is auto-delivered like installation_*; not a phantom R9
        item).
      </code>
      <skip-conditions>Handler returns 200 (no insert) on: non-branch ref
        (refs/tags/* etc.); empty branch after stripping; deleted=true OR
        all-zero `after` SHA; `after` length &lt; 7; missing repo.id or
        installation.id; rate-limit token exhausted; no active repo_connection
        matching BOTH (github_repo_id, github_install_id) (mismatch between
        payload's install and repo is a payload anomaly — skip, do not
        first-claim); no `instances` row for (repo_connection_id, branch)
        — unpinned/untracked; instance.pinned === false (architecture-brief
        §225: only pinned auto-rebuilds on push); dedup hit (23505). Branch-
        with-slash is handled transparently — `refs/heads/feat/x` strips to
        `feat/x` and matches the instances row verbatim.</skip-conditions>
    </step>

    <deviations>buildApp extracted to src/app.ts (handoff bible didn't
      prescribe a layout — kept the refactor minimal and reversible). Token-
      bucket helper lives in `lib/`, not `github/`, because it's domain-neutral
      and the 4.2 worker (and any future inbound surface) can reuse it.
      `enqueuePushBuilds` returns an array of outcomes (one per matched
      connection) rather than a single result — `UNIQUE(github_install_id,
      github_repo_id)` allows at most one match today, but the array shape is
      forward-compatible for any future per-workspace connections without an
      API change. Push event payload type was merged into the existing local
      type in webhook.ts (all fields optional) rather than narrowing per-event
      — keeps the dispatch readable and the parse path single.</deviations>

    <verification>Builds GREEN: @usemount/shared tsc -b, @usemount/api tsc -b,
      @usemount/web tsc --noEmit + `next build` (9 routes, ƒ Proxy intact).
      Harness LIVE-exercised — all 12 cases PASS:
      (1) bad sig → 401, no DB mutation;
      (2) no sig → 401;
      (3) tag push (refs/tags/v1.0.0) → 200, 0 rows;
      (4) branch delete (deleted=true) → 200, 0 rows;
      (5) zero-SHA after → 200, 0 rows;
      (6) unknown repo → 200, 0 rows;
      (7) mismatched install_id → 200, 0 rows;
      (8) unpinned branch → 200, 0 rows on the unpinned instance;
      (9) happy path (pinned, SHA_A) → 200, exactly 1 build_jobs row;
      (10) duplicate push (same instance,sha) → 200, still 1 row (dedup
      via 23505 confirmed);
      (11) different SHA on same instance → 200, 2 total rows;
      (12) flood of 18 distinct SHAs against the same installation_id, FIRED
      VIA Promise.all so wall-clock latency stops dominating the inter-call gap
      (advisor: sequential `await` made the cap=10 assertion timing-flaky on
      slower machines via accidental refill across DB round-trips; bursts are
      the actual threat model) → exactly 10 enqueued, 8 rate-limited (token
      bucket capacity=10 exhausted, 0 DB writes from the rate-limited 8).
      Post-run hosted DB check via Management API: leftover_conns=0,
      leftover_insts=0, total build_jobs=0 — teardown verified clean. PORT-BOOT
      SMOKE (advisor: covers the buildApp/serve refactor delta the in-process
      harness skips): PORT=4001 `tsx src/index.ts` → stdout
      "usemount.dev API running on port 4001"; curl 127.0.0.1:4001/health →
      {"ok":true} HTTP 200; kill clean. NOT exercised (deferred, R7/R9): hosted
      webhook delivery from real GitHub, Railway deploy, real push round-trip
      end-to-end.</verification>

    <known-risks>R7 apps/api never deploy-verified — first staging→main is its
      first hosted run; the new push branch fires automatically once GitHub
      reaches apps/api with the right Webhook URL. R9 cors('*') untouched +
      GitHub App Setup/Webhook URLs unset (Setup → web /connect/callback,
      Webhook → api /github/webhook). No new App event subscription needed
      (push is auto-delivered to every App). R2 the PAT used to apply 0002
      must be deleted in the Supabase dashboard by the owner now. Rate-limit
      reset-on-restart is v1-accepted (single Railway replica); the in-memory
      `Map<installation_id, Bucket>` also never evicts, so distinct install ids
      grow it forever — negligible at v1 scale, swap for a Redis/Postgres-
      backed counter alongside the reset-on-restart upgrade if multi-replica.
      The 0002
      partial index dedup window is `queued`/`running` only — a job that
      finishes (succeeded/failed/canceled) frees the (instance,sha) for
      re-enqueue, which is correct for fault recovery but means a force-push
      to the same SHA after a prior build will rebuild; acceptable. Pre-
      existing unchanged: `[branch]` vs `[...branch]` slug routing (PR3); slug
      scheme non-unique (v1-safe); `pnpm lint` fails on PR2's nav-avatar.tsx
      (missing @next/eslint-plugin-next) — `next build` is the real gate.</known-risks>

    <next>PR6 (Step 4.2): the build worker. STOPS here per handoff; PR6 starts
      with the ask-user-question kickoff on D1 (panel-completeness scope —
      controls schema expansion vs typed read-only rows vs resolution-only
      gate; defines "done" and sizes the PR), then evolves apps/api/scripts/
      spike.ts to checker-primary, iterates until the gap histogram hits zero
      `external-union`/`forwardref-unresolved`/`large-base-type` on dogfood AND
      a real-customer-codebase fresh-clone-from-GitHub run, THEN lifts the
      working logic into apps/api/src/build/worker.ts with the lease loop +
      heartbeat + ephemeral tmpfs clone + `--ignore-scripts` dependency install
      + cached node_modules on a persistent volume + ts-morph static-parse of
      mount.config.ts (RCE — never import()/eval) + per-component esbuild with
      tsconfig path inheritance + CSS extraction validated on a Tailwind-v4
      target + Supabase Storage upload + component_manifests UPSERT/DELETE +
      per-component-failure ≠ job-failure semantics. Doc inversion (decision
      D2 from the handoff) lands in PR6: architecture-brief §3 + §287, dashboard-
      build-plan Step 4, migration-plan Step 4.2, spike.ts's FINDING comment
      all flip "rdt primary" → "checker-backed primary, rdt optional cross-
      check". 4.3/4.4 + Step 5 + R7/R9 hosted cutover all remain explicitly OUT
      of scope of PR6.</next>
  </pr>

  <pr id="6" branch="feat/migration-step-4.2" base="staging" covers="Step 4.2"
      verified="builds+harness-live+e2e+boot-smoke" date="2026-05-20">
    <secrets-policy>No secrets in repo. A session-only Supabase PAT was supplied
      by the owner at PR6 kickoff to apply 0003_build_jobs_lease.sql (Management
      API only); staged to /tmp/usemount-sb-pat mode-600, never echoed back,
      never written to any committed file, shredded at hand-back. The owner
      deletes the PAT in the Supabase dashboard on done-report (R2). The PR6
      harness (verify-build-worker.ts) writes sentinel rows (github_install_id=
      999_999_999_981, branch "test/pr6-worker") to live hosted DB and tears
      them down via ON DELETE CASCADE in a finally block — verified clean after
      the run (0 leftover_conns, 0 leftover_insts, 0 leftover_jobs). All
      GitHub App env (PEM, webhook secret, App-JWT) remains untouched in
      apps/api/.env.local; never leaves the local process.</secrets-policy>

    <decisions>
      <decision id="D1" name="panel-completeness scope" answer="hybrid">
        Owner-chosen at PR6 kickoff via ask-user-question skill: expand
        BuildManifestControls with interactive `string` (text input) and `number`
        (number input) row kinds for the common cheap widgets, AND typed
        read-only rows for `handler` (function signature display) and `object`
        (type-string display). Every checker-resolved prop yields a row; rich
        invoke/JSON-editor widgets for handler/object defer to Step 5. The 4.3
        canvas inherits four new row kinds. Gate = "no component with
        resolvable props ever shows an empty panel; only sanctioned residuals
        (truly-propless helpers + unconstrained generic T) legitimately empty".
        Hits the owner's non-negotiable without building a JSON editor in v1.
      </decision>
      <decision id="D2" name="doc inversion rdt→checker" answer="LANDED in PR6,
        owner-driven, SUPERSEDES the 4.2-prep introspection-truth clause's
        'ship accepting the empty-panel fraction' alternative">
        The 4.2-prep migration-log entry's `<introspection-truth>` clause
        offered the owner a choice: raise the introspection rate in 4.2/Step-5,
        OR ship accepting that ~2 of 3 real components would render with an
        EMPTY controls panel under rdt-primary. The owner rejected the
        empty-panel option as product-breaking. PR6 implements the rate-raise
        via D2: ts-morph CHECKER is the PRIMARY introspection engine;
        react-docgen-typescript becomes the OPTIONAL cross-check on Button only
        in the spike. The checker walks the exported component's call-signature
        parameter type, so it resolves THROUGH forwardRef/HOC AND follows
        cross-file / node_modules aliases via the customer's tsconfig — closing
        external-union (the dominant 14/29 gap on REV-Plugin under rdt) and
        forwardref-unresolved (3/29) to zero. Numeric gate measured: see
        `<verification>` below. The doc inversion (architecture-brief.md §3
        + §11 ×3, dashboard-build-plan.md Step 4 + "Decisions still open" #1,
        migration-plan.md Context + Step 4.2 + Step 5 generics clause) is part
        of commit 2; spike.ts's FINDING comment was already flipped in commit 1.
        This addendum supersedes the "ship accepting the empty-panel fraction"
        alternative in &lt;pr id="4"&gt;'s 4.2-prep `<introspection-truth>` —
        treat this as the new source of truth.
      </decision>
      <decision id="lease-rpc" name="0003 SECURITY DEFINER + lockdown"
        answer="hardened">
        PostgREST can't express `FOR UPDATE SKIP LOCKED`, so the atomic
        worker lease lives behind a SECURITY DEFINER RPC. Pattern (advisor-
        confirmed): `SET search_path = public, pg_temp` on the function
        (closes the schema-injection vector the Supabase linter flags on
        SECURITY DEFINER); `RETURNS SETOF public.build_jobs` (caller uses
        `.maybeSingle()`, gets `null` on empty queue — no error on missing
        record); `REVOKE ALL ... FROM PUBLIC, anon, authenticated` (Supabase
        default-privileges grant EXECUTE to anon/authenticated on every
        public.* function — REVOKE PUBLIC alone does NOT catch those
        role-specific grants, so they need explicit REVOKE; without them an
        anonymous request could call the SECURITY DEFINER and lease a job).
        GRANT EXECUTE only to service_role. Verified live via
        `has_function_privilege` — service=true, anon=false, authenticated=
        false, public=false. NO heartbeat RPC — heartbeat is a plain
        PostgREST update gated on (id, worker_id, status='running'); affected-
        row count = 0 means stolen-lease detection, abort current job.
      </decision>
    </decisions>

    <audit-findings step="0a">
      Pre-PR6 audit (Explore agent + parallel reads + /advisor) of PR5 + carry-
      forward PR4 + 4.0b + 4.2-prep re-confirmed sound: webhook.ts raw-body
      HMAC + length-checked timingSafeEqual + 401-before-parse + lifecycle
      dispatch + push branch positioned correctly; push-enqueue.ts discriminated
      `PushEnqueueOutcome` union + 10 skip reasons + 23505 dedup catch + fan-out
      over active connections; rate-limit.ts token-bucket per (kind,key) with
      deterministic `nowMs` test hook + documented eviction caveat;
      app.ts/buildApp() extraction clean + index.ts no worker loop (PR6 adds);
      verify-push-webhook.ts in-process import pattern (load .env.local AFTER
      static imports — lazy accessors safe); 0002 partial UNIQUE index live in
      hosted DB (verified via pg_indexes: WHERE status IN ('queued','running'));
      installation-ownership.ts hard-denies Org/Enterprise from BOTH callback
      AND connections route; spike.ts has the working `tsMorphProbe` proof
      (lifted into the worker's introspect.ts in PR6). Hosted DB pre-state clean
      (0 build_jobs rows, 0002 + queue_idx + instance_idx + pkey indexes all
      verified). No drift, no holes, audit-clean. The doc-inversion gap (D2) is
      the only carry-forward owner-decision PR6 closes.
    </audit-findings>

    <step-4.2 title="the build worker">
      <db>
        supabase/migrations/0003_build_jobs_lease.sql — SECURITY DEFINER function
        public.lease_next_build_job(p_worker_id text) RETURNS SETOF
        public.build_jobs. Atomic lease via FOR UPDATE SKIP LOCKED on a
        sub-SELECT, predicate `(status='queued') OR (status='running' AND
        leased_at &lt; now() - interval '10 min')` so a crashed worker's stale
        lease re-claims in one atomic UPDATE. SET search_path = public, pg_temp.
        REVOKE ALL FROM PUBLIC, anon, authenticated; GRANT EXECUTE TO service_role.
        Applied via Management API POST /database/query (same triple-
        precedented pattern as PR2/4.2-prep/PR5); verified live via pg_proc
        (prosecdef=true, proconfig=[search_path=public, pg_temp]) and
        has_function_privilege (service=true, anon/auth/public=false).
      </db>
      <code>
        NEW packages/shared/src/build-manifest.ts — BuildManifestControls
        expanded per D1: existing variants/sizes/forms/booleans/slots stay; ADD
        interactive `strings: Array&lt;{prop}&gt;`, `numbers: Array&lt;{prop}&gt;`,
        plus typed read-only `handlers: Array&lt;{prop, signature}&gt;`,
        `objects: Array&lt;{prop, typeString}&gt;`. The 4.3 canvas inherits
        these four new row kinds.

        NEW apps/api/src/build/introspect.ts — the checker-primary engine
        (PR6 D2). PROP_CAP=40, PropKind discriminated union (boolean | string |
        number | literal-union | react-node | handler | object | unknown),
        CheckerProp/CheckerResult shapes, classifyPropKind (react-node FIRST,
        handler before object, strip undefined via getNonNullableType before
        primitive checks, union-of-literals via getUnionTypes()+getLiteralValue,
        complex union/intersection → typed read-only `object`), introspectComponent(project, entry)
        (init Project ONCE; addSourceFileAtPath; getExportedDeclarations →
        first PascalCase with callable signature → first param's
        getTypeAtLocation), deriveControls (every resolved prop yields a row),
        classifyGap (only fires for sanctioned residuals). Spike.ts now imports
        from this module — the spike is a live regression harness for the engine
        the worker runs (advisor-recommended factor).

        NEW apps/api/src/build/types.ts — BuildJob / InstanceRow /
        RepoConnectionRow narrow projections of the DB row shapes the worker reads.

        NEW apps/api/src/build/lease.ts — leaseNextJob(workerId) via
        supabaseAdmin.rpc('lease_next_build_job').maybeSingle&lt;BuildJob&gt;();
        heartbeat(jobId, workerId) = plain PostgREST update gated on
        (id, worker_id, status='running'), returns true on affected-rows&gt;0
        (lease still owned), false on 0 (stolen — caller aborts);
        completeJob/failJob set succeeded/failed + finished_at + duration; failJob
        truncates error to 4000 chars (no TOAST blowups).

        NEW apps/api/src/build/clone.ts — shallowClone({repoFullName,
        commitSha, installToken}) via child_process.spawn('git', ...) (no new
        dep; git is on the worker container by definition — advisor #5).
        Pattern: `git init` + `remote add` + `fetch --depth=1 --no-tags
        --filter=blob:none origin &lt;sha&gt;` + `checkout FETCH_HEAD` —
        works for any commit GitHub serves, not just branch HEADs. Auth via
        `https://x-access-token:&lt;token&gt;@github.com/&lt;repo&gt;.git`.
        `GIT_TERMINAL_PROMPT=0` + `GIT_ASKPASS=echo` so a bad token never
        prompts. Token scrubbed from any stderr surfaced to build_jobs.error.

        NEW apps/api/src/build/deps.ts — detectLockfile (pnpm-lock.yaml /
        package-lock.json / yarn.lock / bun.lockb) → installDeps with
        --ignore-scripts + lockfile-frozen flags. THE control against
        customer-postinstall RCE. node_modules cache keyed by
        (repo_id, sha256(lockfile)) on a PERSISTENT volume (NODE_MODULES_CACHE
        env, default /var/lib/usemount/node-modules-cache, NOT tmpfs). Cache
        hit = cpSync; cache miss = install + best-effort cache write.
        Registry-malicious-dep library code that runs at BUNDLE time remains
        the residual (real containment = 4.3 iframe sandbox).

        NEW apps/api/src/build/mount-config.ts — STATIC AST parse via ts-morph.
        Allowed keys = {componentsDir, globalsCss, hidden}; values must be
        StringLiteral or ArrayLiteralExpression of StringLiteral. Rejects
        CallExpression / Identifier / TemplateExpression / spread / computed
        names / unknown keys with explicit error messages. Fallback chain when
        no mount.config.ts: src/components → components → app/components (and
        globals.css candidates app/globals.css, src/app/globals.css,
        styles/globals.css). NEVER import()/eval — the config file is customer
        source code; executing it would be RCE on the worker AND the iframe
        (4.3). Verified by 4 harness cases (case 10-13).

        NEW apps/api/src/build/bundle.ts — bundleComponent + bundleGlobalsCss
        via esbuild. CRITICAL: passes `tsconfig: opts.tsconfigPath` so esbuild
        inherits the customer's compilerOptions.paths (architecture-brief §287)
        — NOT the spike's PR4 `alias:{'@':ALIAS_BASE}` hardcode (advisor #6).
        Customer codebases with `~components/*`-style aliases would silently
        fail otherwise and look like component bugs. external=
        ['react','react-dom','react/jsx-runtime']; format=esm; jsx=automatic;
        minify=true. CSS extraction via loader:{'.css':'css'} (per-component
        imports of stylesheets get a sibling .css output); globals.css bundled
        once per artifact set (Tailwind v4 + globals.css per v1 support
        matrix). E2E gate confirmed 154KB Button bundle (213ms) resolves the
        `@/*` alias via tsconfig.

        NEW apps/api/src/build/storage.ts — uploadJs + uploadCss to the
        `component-artifacts` bucket (4.2-prep provisioned; private, 50 MiB).
        Service-role bypasses Storage RLS (read-path signing is 4.3 scope).
        Keys = `instance_id/slug.&lt;source_hash&gt;.{js|css}` with `upsert:
        true` for idempotent retry.

        NEW apps/api/src/build/manifests.ts — syncManifests UPSERT on
        (instance_id, slug) + computes set-difference and DELETEs rows whose
        slugs are not in the current build (otherwise renamed/removed
        components leave ghost rows in the sidebar forever).

        NEW apps/api/src/build/worker.ts — startWorkerLoop() returns
        {workerId, stop, done}. Advisor lifecycle pattern: while-loop on
        shuttingDown flag (loop returns naturally — no process.exit from
        inside), heartbeat setInterval stored and clearInterval'd in finally
        (event-loop liveness), orphan-sweep at startup (clean /tmp/usemount-
        build-* from crashed workers), per-job pipeline (lease → fetch
        instance + repo_connection → install token → shallow clone → install
        deps → parse mount.config → init ts-morph Project ONCE → diff vs
        last_synced_commit_sha via `git diff --name-only` over-approximation
        (advisor #5; first sync = build all) → for each .tsx entry: introspect
        → deriveControls → bundleComponent → uploadJs/Css → manifest row.
        Per-component failure → kind='unsupported', job CONTINUES (handoff
        STEP 1 #12). globals.css bundled once at the end. syncManifests UPSERT
        + DELETE stale. update instances.last_synced_*. cloneResult.cleanup()
        in finally — tmpfs source dir destroyed, persistent node_modules cache
        preserved. workerId format: `&lt;RAILWAY_REPLICA_ID|local&gt;-&lt;pid&gt;-&lt;ts&gt;`.

        NEW apps/api/scripts/verify-build-worker.ts — 14-case in-process
        harness (mirrors PR5 verify-push-webhook.ts pattern: import-then-
        loadEnvFile, sentinel rows with TEST_INSTALL_ID=999_999_999_981 to
        avoid PR5 collision, teardown via ON DELETE CASCADE on
        repo_connections in finally). Cases: 1=lease basic queued→running,
        2=stale lease (&gt;10min) reclaimed, 3=fresh lease (&lt;10min)
        preserved, 4=FIFO created_at order, 5=null on empty queue, 6=heartbeat
        refresh, 7=heartbeat false on wrong worker_id (stolen-lease detection),
        8=completeJob succeeded+duration+finished_at, 9=failJob failed+error
        truncated to 4000+duration, 10=mount-config CallExpression rejected,
        11=mount-config Identifier rejected, 12=mount-config unknown-key
        rejected (allowlist enforced), 13=mount-config fallback resolves
        src/components, 14=valid mount.config.ts parses + resolves.

        NEW apps/api/scripts/e2e-fresh-clone.ts — informational E2E exercising
        the load-bearing new pieces (installDeps + bundleComponent with
        tsconfig path inheritance) against a `git clone` of usemount.dev to
        /tmp/usemount-fresh-clone (no node_modules; matches worker post-
        shallow-clone state). Validates installDeps pnpm path + the worker's
        bundle (NOT the spike's `alias` shortcut) on a real customer-like tree.

        MOD apps/api/src/index.ts — buildApp() unchanged; ADD startWorkerLoop()
        alongside serve() (worker enabled by default; DISABLE_BUILD_WORKER=1
        opts out for routes-only dev). Single source of process lifecycle:
        process.once('SIGTERM'/'SIGINT') → worker.stop() → await worker.done →
        httpServer.close() → process.exit(0). Worker no longer installs its
        own signal handlers (single source).

        MOD apps/api/scripts/spike.ts — inverted to checker-primary by importing
        introspectComponent/deriveControls/classifyGap/PROP_CAP from
        ../src/build/introspect.js (engine factored out). rdt stays imported
        for the Button head-to-head cross-check only. FINDING comment flipped
        to record D2 inversion (owner-driven, supersedes 4.2-prep's "ship
        accepting the empty-panel fraction"). Spike is now the live regression
        harness for the worker's engine.

        MOD apps/api/package.json — added `verify:build-worker` and
        `e2e:fresh-clone` script targets; no new deps (ts-morph, esbuild,
        react-docgen-typescript already devDeps from PR4; @octokit/auth-app +
        @supabase/supabase-js already deps from PR3+PR2; git via
        child_process.spawn — advisor #5).

        MOD docs/ — D2 inversion landed in commit 2: architecture-brief.md
        (5 mentions of rdt-primary flipped to checker-primary), dashboard-
        build-plan.md (Step 4 spec + "Decisions still open" #1), migration-
        plan.md (Context + Step 4.2 prose + Step 5 generics clause).
      </code>
    </step-4.2>

    <deviations>
      - PR6's worker.ts uses a separate `processJob(job, workerId, isStolen)`
        helper instead of inlining — keeps the loop readable and lets the
        stolen-lease check thread through each pipeline stage (we abort early
        when heartbeat detects another worker has reclaimed the job).
      - introspect.ts is a fresh module rather than a generalisation of the
        spike's `tsMorphProbe`. The spike's `tsMorphProbe` was a Button-only
        probe returning string[]; the production engine needs rich PropKind
        classification + propsSchema + gap diagnostics, so a clean module
        was the right shape (advisor-recommended factor; spike imports from
        it now — single source).
      - `lease_next_build_job` predicate uses `(status='queued') OR
        (status='running' AND leased_at &lt; now() - interval '10 min')` so a
        crashed worker's stale 'running' lease reclaims atomically. The
        canonical migration-plan.md Step 4.2 prose has the predicate as
        `status='queued' AND (leased_at IS NULL OR leased_at &lt; now() - 10 min)`
        — that doesn't reclaim stale 'running' (status would be 'running',
        not 'queued'); without the disjunction, a crashed worker would block
        the queue forever (0002 dedup index would also deduplicate new pushes
        against the dead 'running' row). PR6's predicate is the correct
        operational shape; spec prose's intent is preserved (stale leases
        reclaim) but the SQL form is fixed.
      - DISABLE_BUILD_WORKER=1 env opt-out added for dev sessions that only
        touch routes — not in the handoff, but minor and non-breaking
        (default behavior: worker enabled).
      - No `simple-git` dependency — `child_process.spawn('git', ...)` works
        and avoids a new dep per CLAUDE.md "prefer what is already in
        package.json" + advisor #5.
      - Mount-config `globalsCss` fallback chain extended beyond the spec
        (app/globals.css / app/global.css / src/app/globals.css /
        styles/globals.css) to cover common Next.js project layouts. Custom
        v1-only deviation; trivial.
    </deviations>

    <verification gate="PR6" result="PASS">
      Spike numeric gate (checker-primary engine, post-install state):
      - dogfood (Tailwind v4, 79 components): introspection-gap histogram =
        {no-props-interface: 25}; external-union=0, forwardref-unresolved=0,
        large-base-type=0. RICH = 54/79 (68%); the 25 no-RICH are propless
        helpers (canvas-background, sidebar-divider, etc.) — sanctioned.
        Every component WITH props has at least one row.
      - REV-Plugin (Tailwind v3, 29 components — out-of-matrix for CSS but
        THE lever for external-union): histogram = {large-base-type: 1,
        no-props-interface: 2}; external-union=0 (was 14 under rdt-primary in
        4.0b — D2 lever closed), forwardref-unresolved=0 (was 3). The 1
        large-base-type is the sanctioned ui-animate-ui-slot Radix-Slot
        re-export — PROP_CAP=40 fires correctly, panel still rich at 40 rows
        (5 booleans, 23 strings, 1 number, 10 objects, 1 variant). RICH =
        27/29 (93%); the 2 no-RICH are Radix wrappers without their own props
        interface (ui-popover, ui-tooltip) — sanctioned. Up from 4.0b's 34%.
      - dogfood with node_modules deleted (the worker pre-install state):
        forwardref-unresolved=9, bundled=19/79 — confirms the worker's
        install step is LOAD-BEARING. The engine degrades gracefully
        without deps installed; the worker's `--ignore-scripts --frozen-
        lockfile` install MUST precede introspect+bundle. Mission: confirmed.

      verify-build-worker.ts harness (live hosted DB): 14 cases PASS.
      Sentinel teardown clean: leftover_conns=0, leftover_insts=0,
      leftover_jobs=0.

      e2e-fresh-clone.ts on /tmp/usemount-fresh-clone: pnpm install
      --ignore-scripts --frozen-lockfile 35s (cold), Button checker = 14
      props in 513ms with gap=none + variants/sizes/forms/3-booleans/string/
      handler/slot rows all resolved, bundleComponent 154KB JS in 213ms
      (tsconfig path inheritance for `@/*` working — NOT the spike's `alias`
      shortcut).

      Port-boot smoke (`PORT=4001 tsx src/index.ts`): both `[worker:local-...]
      startup` AND `usemount.dev API running on port 4001` logged; `/health
      → {"ok":true}` HTTP 200; SIGTERM → `[main] SIGTERM — shutting down` →
      `[worker:...] explicit stop — finishing current job, then exiting` →
      process exit clean; build_jobs row count = 0 after teardown.

      0003 verified live: pg_proc.prosecdef=true, proconfig=[
      'search_path=public, pg_temp'], args='p_worker_id text', ret='SETOF
      build_jobs'. has_function_privilege: service=true, anon=false,
      authenticated=false, public=false.

      Builds GREEN: pnpm --filter @usemount/shared build (tsc -b) clean;
      pnpm --filter @usemount/api build (tsc -b) clean; pnpm --filter
      @usemount/web exec tsc --noEmit clean; pnpm --filter @usemount/web
      build (next build) 9 routes incl. ƒ Proxy (Middleware) intact.

      NOT exercised (deferred, R7/R9): hosted GitHub clone via real install
      token, Railway deploy of the worker loop, real push → build_job →
      worker pipeline end-to-end. The fresh-clone E2E uses a LOCAL clone
      (git clone the dogfood to /tmp) — same FS state the worker sees post-
      shallowClone, but skips the GitHub leg. A genuine fresh-clone-from-
      GitHub run lives behind R7/R9.
    </verification>

    <known-risks>
      Carry-forward from PR3/PR4/PR5:
      - R1 two-app footgun stands (apps/api uses ONLY the GitHub App; the
        OAuth App is only for Supabase sign-in).
      - R7 apps/api never deploy-verified — first staging→main is first
        hosted run; PR6 adds a long-running worker loop alongside the HTTP
        server, which is a NEW Railway-deploy concern (not just HTTP).
      - R9 cors('*') untouched + GitHub App Setup/Webhook URLs unset
        (Setup → web /connect/callback, Webhook → api /github/webhook). No
        new App event subscription needed (push is auto-delivered).
      - R2 PAT used to apply 0003 must be deleted in Supabase dashboard by
        owner now (same triple-precedent pattern as PR2/4.2-prep/PR5).
      - Rate-limit in-memory Map (PR5) never evicts — v1-accepted, multi-
        replica swap to Redis when needed.

      PR6-introduced:
      - **node_modules cache eviction unsolved** (advisor-flagged): keyed by
        (repo_id, sha256(lockfile)) on a persistent volume; grows unbounded
        over time. Step 5 owns the LRU question. v1-accepted; at two-customer
        scale the cache is a few GB.
      - **Worker SIGTERM/SIGINT handler is `process.once(...)`** — first
        signal triggers graceful shutdown; a second signal during shutdown
        will be the default handler (kill). Acceptable for v1.
      - **Stale-lease 10-min window**: a network hiccup that drops a 2-min
        heartbeat for &gt;10 min could let another worker reclaim a still-
        alive job → double-build. Conservative window; revisit if hosted
        traffic data shows it's real.
      - **No retry on transient bundle/upload failures** — per-component
        failures mark `kind='unsupported'` and the job succeeds with the
        rest. v1-accepted; per-component retry is Step 5 polish.
      - **`git diff` over-approximation**: any change outside the components
        dir → rebuild all. Cheaper than reverse-walking esbuild metafiles
        for shared-dep tracking; the more precise approach is Step 5.
      - **Worker pulls fromSha via shallow clone of only toSha** — the
        diff against last_synced_commit_sha will fail (commit not present)
        and conservatively rebuild all. Acceptable for v1; widening the
        clone to include fromSha is Step 5 polish.
      - **The PR6 fresh-clone E2E uses a LOCAL clone** — a genuine fresh-
        clone-from-GitHub run via the install token lives behind R7/R9.
      - **mount.config.ts auto-detect from monorepo root won't find a
        nested components dir** (the dogfood lives at apps/web/components/
        live, not src/components). Step 5 surfaces this as a setup screen.

      Pre-existing, not yours to fix:
      - `[branch]` vs `[...branch]` slug routing.
      - Non-unique slug scheme (v1-safe).
      - `pnpm lint` fails on PR2's nav-avatar.tsx (missing
        @next/eslint-plugin-next) — `next build` is the real gate.
    </known-risks>

    <next>
      PR7 = Step 4.3 (iframe runtime + canvas wiring + sandbox hardening):
      `apps/web/app/preview/[manifestId]/route.ts` serves a minimal HTML doc
      that mounts the bundle + supplies router + theme defaults; iframe gets
      `sandbox="allow-scripts"` WITHOUT `allow-same-origin`; strict CSP
      `default-src 'none'; script-src 'self' &lt;storage-domain&gt;; style-
      src 'self' 'unsafe-inline'; connect-src 'none'; frame-ancestors 'self'`;
      narrow typed `postMessage` protocol (init, setProps, error, ready);
      rewire `DEMO_REGISTRY` → Supabase query keyed on instance_id; delete
      `lib/registry/data.ts` once provider reads real data; the 4.3 canvas
      panel must render the new D1 row kinds (string text-input, number
      input, handler/object typed read-only). THE crown-jewel security
      surface; gets its own focused handoff. PR8 = Step 4.4 (Realtime
      stale-viewer — replace `stale-viewer-trigger.tsx` 30s setTimeout with
      supabase.channel('instance:...').on('postgres_changes')).

      Step 5 (manifest auto-generation polish): provider auto-detect from
      `app/layout.tsx`, `canvas.providers.tsx` fallback,
      `Component.canvas.tsx` per-component overrides, failure-mode
      dispositions (architecture-brief §3 cases 1–7), support-matrix
      connect-gate (Tailwind v3 / Next 15 must be REFUSED at connect time —
      REV-Plugin proved this gate is load-bearing), stale-instance
      reconciler (every N hours), node_modules cache LRU eviction.

      R7/R9 = coordinated hosted cutover (Railway deploy + GitHub App Setup
      URL + Webhook URL + CORS lock + custom-domain DNS). Worth doing as one
      coherent gate, not piecemeal.

      Before PR7: confirm PAT was deleted in Supabase dashboard; if a 0004+
      migration or Storage RLS policy is needed there, request a fresh
      session-only PAT (triple-precedent + advisor pattern).
    </next>
  </pr>

  <pr id="7" branch="feat/migration-step-4.3" base="staging" covers="Step 4.3"
      verified="builds+harness-live+no-regression+boot-smoke" date="2026-05-20">
    <secrets-policy>No secrets in repo. A session-only Supabase PAT was
      supplied by the owner at PR7 kickoff to re-verify the PR6 0003 RPC
      privileges + confirm `component_views` / `component_manifests` shape +
      probe the `component-artifacts` bucket — Management API only; staged
      to /tmp/usemount-sb-pat mode-600, never echoed back, never written to
      any committed file, shredded at hand-back. PR7 introduces no new
      SECURITY DEFINER functions and no new migrations, so the live DB
      footprint from this PR is just sentinel rows the verify-iframe harness
      writes + deletes inside a finally block (TEST_INSTALL_ID=
      999_999_999_971, branch "test/pr7-iframe"). Storage objects the
      sentinel uploads to component-artifacts are removed in the same
      teardown; verified clean post-run (leftover_conns=0,
      leftover_storage=0).</secrets-policy>

    <decisions>
      <decision id="D1" name="iframe separate-origin" answer="same-origin v1 + R9 cleanup">
        Owner-chosen at PR7 kickoff via ask-user-question skill. The iframe
        is served from `/preview/[manifestId]` on the dashboard host;
        `sandbox="allow-scripts"` WITHOUT `allow-same-origin` already gives
        opaque-origin semantics (host cookies/storage/DOM unreachable from
        the iframe's JS, parent.document access throws SecurityError,
        localStorage scoped to the iframe's opaque origin). Cross-origin is
        a defense-in-depth multiplier — deferred to the R9 coordinated
        cutover where the `preview.usemount.dev` subdomain is created
        alongside Railway URLs / GitHub App URLs / CORS lock. Documented as
        a known v1 limit in known-risks; the route handler is identical
        either way (only hostname binding differs).
      </decision>
      <decision id="D2" name="ComponentManifest.render disposition" answer="delete render field">
        Owner-chosen. The render-side `ComponentManifest<P>` (in
        packages/shared/src/manifest.ts) carried `render: (props) =>
        ReactNode` from the demo era — an in-host inline-render concept the
        4.3 iframe pipeline supersedes. PR7 collapses the manifest duality
        the PR4 spike surfaced (PR6 build-side comment in build-manifest.ts):
        ComponentManifest now `extends BuildManifest` with `id` (DB row
        uuid), `instanceId` (for component_views inserts), and
        `defaultProps` (synthesized client-side from `controls` via
        `packages/shared/src/synthesize-defaults.ts` — first option for
        variants/sizes/forms, `false` for booleans, `""` for strings, `0`
        for numbers; handlers/slots/objects left undefined so customer
        component default parameters take over). One shape, one source of
        truth: the `component_manifests` row IS the canvas manifest.
      </decision>
      <decision id="D3" name="signed-URL TTL" answer="15 min">
        Standard for ephemeral build artifacts. Long enough for slow
        connections to fetch the bundle + CSS; short enough that a leaked
        URL ages out within one viewing session. Implemented via
        `supabase.storage.from('component-artifacts').createSignedUrl(path,
        15*60)` from server-side admin client (`apps/web/lib/storage/
        signed-url.ts`). Browser never sees service-role.
      </decision>
      <decision id="export-discovery" name="bundle component lookup" answer="heuristic in iframe">
        PR6's worker writes `title: slug` (path-derived hyphen-name, e.g.
        `button-button`), not the customer's PascalCase export name. The
        iframe bootstrap discovers the component via heuristic:
        `mod.default` first, else first PascalCase function in
        `Object.entries(mod)`. Order matches PR6's `introspectComponent`
        which picks the first PascalCase from `getExportedDeclarations()`,
        and esbuild's `format: 'esm'` preserves export names through
        minification. Zero PR6 module touches. Step 5 hardens via
        `entryExportName` in BuildManifest if non-PascalCase patterns
        emerge — documented in known-risks.
      </decision>
    </decisions>

    <audit-findings step="0a">
      Pre-PR7 audit of PR6 (Explore agent + Management API verification with
      session-only PAT) returned 15/15 PASS. Concretely re-confirmed live:
      - `apps/api/src/build/worker.ts`: shuttingDown flag + natural loop
        return, heartbeat setInterval stored + clearInterval in finally,
        orphan sweep at startup, per-component fail ≠ job fail,
        build_status='succeeded' (NOT 'synced' — the advisor-caught enum
        bug at PR6 done-gate). All present.
      - `apps/api/src/build/introspect.ts`: classifyPropKind order correct
        (react-node FIRST, handler before object, primitives on
        getNonNullableType, union-of-literals via getUnionTypes +
        getLiteralValue, complex union/intersection → typed object). PROP_
        CAP=40 exported. introspectComponent/deriveControls/classifyGap all
        exported.
      - `apps/api/src/build/mount-config.ts`: static AST only (no
        import()/eval), ALLOWED_KEYS = {componentsDir, globalsCss, hidden},
        CallExpression/Identifier/spread/computed/unknown-key all rejected.
      - `apps/api/src/build/bundle.ts`: uses `tsconfig: opts.tsconfigPath`
        (not the spike's `alias:{'@':...}` shortcut). external React+JSX-
        runtime confirmed.
      - `apps/api/src/build/lease.ts`: leaseNextJob uses RPC; heartbeat is
        plain PostgREST UPDATE gated on (id, worker_id, status='running').
      - `apps/api/src/index.ts`: startWorkerLoop alongside serve;
        process.once SIGTERM/SIGINT (single source); DISABLE_BUILD_WORKER
        opt-out wired.
      - `packages/shared/src/build-manifest.ts`: D1 hybrid expansion intact
        (9 row kinds — variants/sizes/forms/booleans/slots/strings/numbers/
        handlers/objects).
      - 0003 RPC LIVE via Management API: `prosecdef=true`,
        `proconfig=['search_path=public, pg_temp']`, args='p_worker_id
        text', ret='SETOF build_jobs'. ACL via pg_proc.proacl =
        `{postgres=X/postgres,service_role=X/postgres}` — service_role is
        the ONLY non-postgres grant; PUBLIC absent (REVOKE effective).
        has_function_privilege: service=true, anon=false, auth=false.
      - 0002 partial UNIQUE index live: `WHERE status IN
        ('queued','running')` (4 indexes on build_jobs total).
      - `build_status` enum live = `{queued, running, succeeded, failed,
        canceled}` — confirms PR6's 'synced'→'succeeded' fix sticks.
      - `component-artifacts` bucket present, private, 50 MiB/object. List
        prefix returns [] (no real builds yet — R7/R9 deferred).
      - `.gitignore` `!apps/api/src/build/` negation present.
      No drift, no holes, audit-clean. PAT used Management-API only and
      shredded at hand-back.
    </audit-findings>

    <step-4.3 title="iframe runtime + canvas rewire">
      <db>
        No migrations applied in PR7. PR6's `component_manifests` shape
        (id, instance_id, slug, folder_path, title, kind, variants_json,
        states_json, props_schema_json, artifact_url, source_hash,
        created_at, updated_at) and `component_views` shape (id, instance_id,
        manifest_id nullable, viewer_user_id nullable, viewed_at default
        now()) already cover Step 4.3. Existing RLS policies (cm_sel,
        cv_ins/cv_sel via `is_workspace_member()`) gate the route handler's
        manifest fetch and the IframeMount telemetry insert respectively;
        no 0004 needed because the iframe reads via signed Storage URLs
        (service-role signs server-side, browser sees only the signed URL).
      </db>
      <code>
        NEW packages/shared/src/iframe-protocol.ts — versioned typed
        postMessage protocol. HostToIframe = init|setProps (props payload
        validated as object). IframeToHost = ready|resize|error (bbox
        validated as {width, height} finite non-negative numbers; error
        message validated as string). Both sides validate `v ===
        IFRAME_PROTOCOL_VERSION` (== 1) on every receive. Type guards
        isHostToIframe / isIframeToHost; harness exercises 13 positive +
        negative cases.

        NEW packages/shared/src/synthesize-defaults.ts — synthesizeDefaultProps
        derives a Record&lt;string, unknown&gt; from BuildManifestControls
        (D2 collapse needs it because the worker never emitted default
        VALUES — only TYPES). first option for variants/sizes/forms; false
        for booleans; "" for strings; 0 for numbers; handlers/slots/objects
        left undefined so customer component default parameter values take
        over.

        MOD packages/shared/src/manifest.ts — ComponentManifest no longer
        generic; now `extends BuildManifest` with id + instanceId +
        defaultProps. `render` field DELETED (D2). AnyComponentManifest
        becomes a plain alias for ComponentManifest.

        MOD packages/shared/src/index.ts — re-exports the two new modules.

        NEW apps/web/lib/registry/from-supabase.ts — server-side
        `fetchInstanceRegistry(supabase, instanceId)` returns
        `{registry: Registry, manifests: Map&lt;id, ComponentManifest&gt;}`.
        Builds the sidebar tree from each row's `folder_path` (one folder
        per unique parent path, alphabetical), maps the rows into
        ComponentManifest objects with synthesized defaults. Tolerates
        partial / missing variants_json with an EMPTY_CONTROLS fallback so
        a degraded row never crashes the canvas.

        NEW apps/web/lib/storage/signed-url.ts — server-only (import
        "server-only" guards client import). `signStoragePath(path)` calls
        admin client `createSignedUrl(path, 15*60)`. `signGlobalsCss(instanceId)`
        lists the bucket prefix sorted by updated_at desc, picks the first
        `globals.&lt;hash&gt;.css` match (the hash isn't persisted to a DB
        column so the worker overwrites with hash-pinned keys; the route
        finds the freshest). One extra Storage roundtrip per /preview hit
        — v1 acceptable.

        NEW apps/web/lib/preview/iframe-html.ts — pure helpers factored
        out so the verify-iframe harness can assert on the CSP string and
        HTML shape without spinning up the Next runtime. `buildCsp(nonce,
        storageHost)` returns the strict CSP; `renderIframeHtml(opts)`
        produces the full HTML doc with nonce-protected importmap +
        bootstrap; `renderErrorHtml(message)` produces the 4xx body.

        NEW apps/web/app/preview/[manifestId]/route.ts — GET handler.
        Validates manifestId is a UUID; fetches the row via the server
        client (RLS gates non-members of the workspace); refuses
        kind=maybe-rsc / kind=unsupported / null artifact_url with
        renderErrorHtml; signs the JS bundle + (optional) per-component
        CSS + (best-effort) globals.css via the signed-url helper; emits
        the iframe HTML with per-request 16-byte base64 nonce. Response
        headers: content-security-policy, cache-control (private, just
        under TTL), x-content-type-options nosniff, x-frame-options
        SAMEORIGIN, referrer-policy no-referrer. Iframe bootstrap (inside
        renderIframeHtml) listens for postMessage, validates source ===
        window.parent + message shape, dynamic-imports the bundle, picks
        the component via heuristic (default → first PascalCase function),
        mounts into #root via createRoot, posts ready (bbox) then waits
        for init, then setProps on subsequent host updates. ResizeObserver
        on #root posts `resize` on non-zero bbox change. window.error +
        unhandledrejection forwarded as `error` postMessages.

        NEW apps/api/scripts/build-preview-runtime.ts — one-shot esbuild
        of `react` + `react-dom` + `react-dom/client` + `react/jsx-runtime`
        into `apps/web/public/preview-runtime/*.mjs` (4 files, 208 KB
        total minified). `absWorkingDir: apps/web` so esbuild resolves
        from the web app's node_modules (apps/api has no React dep).
        Idempotent; re-run when bumping React. Artifacts checked into the
        repo so the deploy doesn't depend on postinstall scripts.

        NEW apps/web/public/preview-runtime/{react,react-dom,
        react-dom-client,react-jsx-runtime}.mjs — built artifacts;
        production React 19 ESM.

        NEW apps/web/components/live/iframe-mount/iframe-mount.tsx — the
        host-side React wrapper. Props: manifestId, instanceId, props,
        title, onBbox, onError. Renders `&lt;iframe sandbox="allow-scripts"
        scrolling="no"&gt;` sized from the iframe's reported bbox (initial
        1x1; non-zero ready/resize sizes it). Validates incoming
        postMessages via `isIframeToHost` + event.source === iframe.
        contentWindow; never reads anything else from the message.
        Telemetry: one `component_views` insert per mount via the browser
        Supabase client (RLS-gated; failures logged in dev, never
        surfaced).

        NEW apps/web/components/live/iframe-mount/index.ts — barrel.

        NEW apps/api/scripts/verify-iframe.ts — 38-case in-process harness
        (mirrors PR5/PR6 patterns). Sentinel ids: TEST_INSTALL_ID=999_999_
        999_971, repo_id 999_999_999_972, branch "test/pr7-iframe". Cases:
        (a) 13 protocol type-guard cases (positive + negative for all 5
        message kinds); (b) 10 synthesize-defaults cases (empty + every D1
        row kind matrix); (c) 10 Storage sign+HEAD cases (JS, CSS, globals
        list+sign+HEAD, ACAO header presence, missing-key error); (d) 5 DB
        sentinel cases (manifest insert/select via service-role + all 9 D1
        rows round-trip + component_views insert). Teardown removes
        Storage objects + cascades via repo_connections delete. 38/38 PASS;
        leftover_conns=0, leftover_storage=0.

        MOD apps/web/components/live/sidebar-panel/sidebar-panel-provider.tsx —
        SidebarPanelProvider accepts `initialRegistry?: Registry` +
        `initialManifests?: Map&lt;string, ComponentManifest&gt;` props
        (both default to empty-but-valid shapes so legacy /playground
        mounts still render). DEMO_REGISTRY import removed. Context value
        gains `manifests` for the canvas-controls bridge.

        MOD apps/web/components/live/sidebar-panel/index.ts — exports
        useSidebarPanelContext from the barrel (the canvas chain now
        imports it).

        MOD apps/web/components/live/canvas-controls/canvas-controls-context.tsx —
        reads the manifest map from useSidebarPanelContext (replacing the
        demo `getManifest()` lookup against MANIFESTS in lib/registry/
        manifests.ts). manifest.defaultProps drives the initial props
        state + reset target.

        MOD apps/web/components/live/canvas-controls/properties-panel.tsx —
        renders 4 new D1 row kinds (strings → text input, numbers → number
        input, handlers → typed read-only signature row, objects → typed
        read-only typeString row). Existing 5 row kinds (variants/sizes/
        forms/booleans/slots) unchanged in look. Helpers `PropRow`,
        `TextInput`, `NumberInput`, `TypeBadge`, `labelOf`, `toNumber`
        added to keep the rendering tidy. Dropped now-redundant optional
        chains on `controls.booleans?` / `controls.slots?` (the
        BuildManifestControls fields are required arrays).

        MOD apps/web/components/live/app-shell/app-shell.tsx — accepts
        `initialRegistry` + `initialManifests`, threads them into
        SidebarPanelProvider. instance prop unchanged.

        MOD apps/web/components/live/app-shell/canvas-stage.tsx — reads
        the registry from useSidebarPanelContext (replacing DEMO_REGISTRY).
        selectedId-to-leaf resolution otherwise identical.

        MOD apps/web/components/live/app-shell/stage-content.tsx —
        manifest.render(props) at the old :127 callsite replaced with the
        IframeMount component (gated on manifest.kind === "component" AND
        manifest.artifactUrl). kind=maybe-rsc renders a "Server component
        — not supported" tile inline (architecture-brief §3 failure mode
        1); kind=unsupported / null artifactUrl renders a "Couldn't
        initialize" tile. ResizeObserver replaced with the iframe's
        postMessage bbox flow via `onIframeBbox` callback (first non-zero
        bbox = setContentBbox, subsequent = updateContentBboxBounds).

        MOD apps/web/app/[workspace]/[repo]/[branch]/page.tsx — after the
        existing best-effort instance resolution, calls
        fetchInstanceRegistry to pre-fetch the sidebar tree + manifest
        map server-side; threads both into AppShell. Empty registry on
        resolution failure (degrades to "no components yet" rather than
        throwing).

        MOD apps/web/app/playground/specimens/team-switcher-specimens.tsx —
        the only remaining DEMO_REGISTRY/DEMO_TEAMS_MULTI consumer; the
        couple of Team rows it needs are inlined into the specimen file so
        the demo data file can be deleted cleanly.

        MOD apps/api/package.json — added `verify:iframe` +
        `build:preview-runtime` script targets. No new deps (esbuild + tsx
        already devDeps from PR4/PR6).

        MOD migration-plan.md — Step 4.3 prose updated to flag PR7 closure
        + D1/D2/D3 outcomes (this entry recording the full delivery).

        DELETED apps/web/lib/registry/data.ts (DEMO_REGISTRY); apps/web/lib/
        registry/manifests.ts (buttonManifest + getManifest); apps/web/lib/
        registry/manifest-types.ts (re-export stub no longer needed —
        canvas chain imports types directly from @usemount/shared);
        apps/web/components/live/button/button.manifest.tsx (the demo
        manifest — the live Button component on the canvas now comes from
        the iframe).
      </code>
    </step-4.3>

    <deviations>
      - Bundle export discovery is HEURISTIC in the iframe (mod.default
        then first PascalCase function), not a deterministic `mod[title]`
        lookup. PR6's worker persists `title: slug` (path-derived
        hyphen-name), not the customer's PascalCase export name. The
        advisor flagged three options: (a) heuristic walk, (b) add
        entryExportName + 0004 migration, (c) modify PR6's bundle.ts to
        re-wrap entry as default. PR7 picks (a) — zero PR6 module touches,
        v1 works for dogfood + REV-Plugin. Documented in known-risks for
        Step 5 hardening.
      - globals.css Storage key resolution at route-handler time via
        `storage.from(...).list(`${instanceId}/`)` sorted by updated_at
        desc, picking the first `globals.&lt;hash&gt;.css` match. The
        worker emits `${instanceId}/globals.&lt;hash&gt;.css` but the hash
        isn't persisted to a DB column. Listing adds one extra Storage
        roundtrip per /preview hit (~tens of ms). The migration-plan.md
        spec didn't prescribe this seam; v1 acceptable.
      - `JSON.stringify` results interpolated into `<script>` bodies
        (importmap + BUNDLE_URL) run through `jsonForScript()` which
        post-processes `<` → `<`. `JSON.stringify` doesn't escape
        `<` natively, so a signed Storage URL containing `</script>` —
        unlikely but not impossible — would close the host script tag
        early. Standard JSON-in-HTML pattern; defensive at the crown-
        jewel surface.
      - Iframe bootstrap is constructed in `apps/web/lib/preview/
        iframe-html.ts` as a template literal in the route. The handoff
        recommended `apps/web/lib/registry/from-supabase.ts` (registry
        side) and a separate concern for the route HTML. PR7 puts pure
        HTML/CSP helpers in `apps/web/lib/preview/iframe-html.ts` so the
        harness can assert on shape without spinning up Next. Trivial
        path-naming deviation; clean separation.
      - Self-hosted React ESM build script lives in `apps/api/scripts/`
        (not `apps/web/scripts/`) — apps/api already has esbuild + tsx as
        devDeps; adding them to apps/web would be net-new manifest entries
        for a script that runs once per React bump. `absWorkingDir:
        apps/web` so esbuild resolves react from the web app's
        node_modules. Outputs land in `apps/web/public/preview-runtime/`.
      - `react-dom` (top-level) added to the importmap + build alongside
        `react-dom/client`. The PR6 bundle externalizes `react-dom` even
        though most React 19 client code uses `react-dom/client`;
        belt-and-braces shipping both lets customer components that use
        `createPortal` (which lives at `react-dom`'s top-level) work.
      - CSP allows `style-src 'self' 'unsafe-inline' https://&lt;storage&gt;`
        — `'unsafe-inline'` is required because customer components use
        inline `style={{ ... }}` props (CONVENTIONS.md token system is
        style-prop heavy). Script-src stays nonce-only — no
        `'unsafe-inline'` for scripts.
      - Iframe sizing from postMessage `ready`/`resize` bbox (initial 1×1
        until first non-zero); zero-bbox events filtered at both sides so
        the host doesn't snap-fit to (0, 0) on the empty pre-render frame.
      - ComponentManifest type collapse (D2) renames the prior generic
        `ComponentManifest&lt;P&gt;` to a non-generic shape extending
        BuildManifest. AnyComponentManifest preserved as an alias for
        consumers that imported it. No external callers had to change.
    </deviations>

    <verification gate="PR7" result="PASS">
      verify-iframe harness (live hosted DB + live Storage): 38 cases PASS.
      Breakdown:
      - 13 iframe-protocol type-guard cases (positive + negative across
        init/setProps/ready/resize/error).
      - 10 synthesize-defaults cases (empty controls + every D1 row kind
        producing the correct default).
      - 10 Storage sign + HEAD cases (JS, CSS, globals list+sign+HEAD,
        ACAO header present, missing-key createSignedUrl errors).
      - 5 DB sentinel cases (manifest insert + 9 D1 rows round-trip +
        component_views insert via service-role).
      Teardown clean: leftover_conns=0, leftover_storage=0.

      No-regression: verify-push-webhook (PR5, 12 cases) PASS; verify-
      build-worker (PR6, 14 cases) PASS — both unchanged.

      Builds GREEN: pnpm --filter @usemount/shared build (tsc -b) clean;
      pnpm --filter @usemount/api build (tsc -b) clean; pnpm --filter
      @usemount/web exec tsc --noEmit clean; pnpm --filter @usemount/web
      build (next build) 10 routes incl. the new `ƒ /preview/[manifestId]`
      and `ƒ Proxy (Middleware)` intact.

      Port-boot smoke (PR5/PR6 pattern): two passes.
      - DISABLE_BUILD_WORKER=1 on port 4007: only `usemount.dev API running
        on port 4007` startup line, `/health → {"ok":true}` HTTP 200,
        SIGTERM → `[main] SIGTERM — shutting down` → clean exit.
      - Worker enabled on port 4008: both `[worker:local-...] startup` AND
        `usemount.dev API running on port 4008` lines, `/health → 200`,
        SIGTERM → `[main]` then `[worker:...] explicit stop — finishing
        current job, then exiting`, clean exit.

      0003 RPC live re-verified via Management API: prosecdef=true,
      proconfig=['search_path=public, pg_temp'], args='p_worker_id text',
      ret='SETOF build_jobs'. has_function_privilege: service=true,
      anon=false, auth=false. ACL via pg_proc.proacl =
      `{postgres=X/postgres,service_role=X/postgres}` — PUBLIC absent
      (REVOKE effective; PR6 lockdown holds).

      Storage `component-artifacts` bucket private, 50 MiB/object; PR7
      sentinel uploads succeed, HEAD returns 200 + ACAO header, signed-
      URL TTL respected, list-prefix sort by updated_at desc returns the
      globals match.

      Live HTTP smoke against `next start` on port 4010 (advisor #3):
      `/preview/notauuid` → 400 Bad Request with the error-page CSP
      (`default-src 'none'; style-src 'unsafe-inline'; frame-ancestors
      'self';`), `content-type: text/html`, `x-content-type-options:
      nosniff`. `/preview/00000000-0000-0000-0000-000000000000` (well-
      formed UUID, no matching row) → 404 Not Found with same headers.
      Confirms the route is reachable + path validation + RLS-filtered
      DB lookup + error CSP emit. Server boot clean, SIGTERM clean.

      NOT exercised (deferred, R7/R9): live iframe in a real browser
      (sandbox attribute enforcement, customer bundle dynamic import,
      postMessage round-trip with actual React rendering). The pure-
      function harness validates the HTML/CSP shape + protocol guards +
      Storage end-to-end; the live browser smoke fires when the first
      real build lands via R7/R9 (Railway deploy + GitHub webhook). The
      `next build` + `next start` HTTP smoke validate compile-time +
      runtime reachability + header shape.

      Brand-WIP files (modified `icon.svg`/`dashboard-nav.tsx`/`login-
      screen.tsx`/`sidebar-header-zone.tsx`, deleted `mount-glyph.svg`/
      `mount-wordmark.svg`, untracked `mount-logo-*.svg`, `design-philosophy/
      Design Purgatory/`) — untouched throughout the session, travel via
      native git through `git checkout staging` and the merge.
    </verification>

    <known-risks>
      Carry-forward from PR3/PR4/PR5/PR6:
      - R1 two-app footgun stands (apps/api uses ONLY the GitHub App).
      - R7 apps/api never deploy-verified; first staging→main is first
        hosted run. PR7's iframe runtime adds a NEW Railway deploy
        concern: the `/preview-runtime/*.mjs` static assets must ship with
        the web app's `public/` folder (Next 16 handles this by default).
      - R9 cors('*') untouched + GitHub App Setup/Webhook URLs unset.
        Iframe D1=same-origin v1 piles a new R9 item: lift to
        `preview.usemount.dev` subdomain for cross-origin defense-in-depth.
      - R2 PAT used in audit + verify-iframe shredded after run; owner
        deletes in Supabase dashboard at hand-back (same triple-precedent
        pattern as PR2/4.2-prep/PR5/PR6).
      - Rate-limit + node_modules cache eviction + worker SIGTERM
        `process.once` + stale-lease 10-min window + git-diff over-
        approximation + processJob never exercised end-to-end — all PR6-
        carry-forward, all v1-accepted.

      PR7-introduced:
      - **Iframe is same-origin (D1=c)** — defense-in-depth multiplier
        deferred to R9 cleanup (`preview.usemount.dev` DNS + route
        hostname binding). The sandbox attrs + opaque-origin semantics
        + strict CSP + frame-ancestors 'self' already enforce isolation
        at the JS level; R9 widens the moat at the network/origin level.
      - **Bundle export discovery is heuristic** (mod.default OR first
        PascalCase function). Works for dogfood + REV-Plugin (PR6 spike's
        introspect picks the same first PascalCase from
        getExportedDeclarations()). Fails for: non-PascalCase exported
        components, re-export-only modules (`export * from "./impl"`),
        bundles where esbuild flattens to multiple PascalCase exports
        from re-exports. Step 5 hardens via `entryExportName: string` in
        BuildManifest if these patterns emerge.
      - **globals.css key resolution via Storage list** (one extra
        roundtrip per /preview hit). The worker uploads `${instanceId}/
        globals.&lt;hash&gt;.css`; the hash isn't persisted to a DB
        column. v1 acceptable; Step 5 may persist a `globals_css_key`
        column on `instances` if list-cost becomes measurable.
      - **Signed-URL TTL leaks** (15-min reuse window) — accepted v1
        trade-off for fewer signing roundtrips.
      - **CSP `style-src 'unsafe-inline'`** required because customer
        components use inline `style={{ ... }}` props (project
        CONVENTIONS.md is style-prop heavy). Script-src stays nonce-only;
        no `'unsafe-inline'` for scripts. Style attr enforcement awaits
        either CSS-class conversion (Step 5+) or `'unsafe-hashes'`
        coverage (per-style hash; impractical for varied prop values).
      - **No live-browser sandbox attestation in this session** — the
        verify-iframe harness validates pure functions + Storage + DB,
        but the actual browser-enforced sandbox boundary (parent.document
        throws SecurityError, fetch blocked by `connect-src 'none'`,
        opaque-origin localStorage) fires only when a real browser
        renders the iframe. The CSP header string + sandbox attrs are
        structurally correct per spec; full live exercise lands when the
        first real build is hosted (R7/R9).
      - **Theme inheritance gap** — customer `globals.css` typically
        defines `[data-theme="dark"]` selectors that gate the dark variant
        of every token. The iframe `<html>` has no `data-theme` attribute
        set, so dark variants never activate; the preview renders in light
        mode even when the parent dashboard is in dark mode. v1 acceptable
        (visual mismatch only on dark-mode hosts). Step 5 lifts it via a
        `theme: 'light' | 'dark'` field on the `HostToIframe.init` payload
        + a one-line `document.documentElement.dataset.theme = ...` in the
        iframe bootstrap.
      - **`maybe-rsc` / `unsupported` tile is rendered inside the canvas
        stage**, not the sidebar. The sidebar shows disabled leaves
        (per `disabled: kind !== "component" || !artifact_url` in
        from-supabase.ts), but a click still navigates and lands on the
        canvas tile. Step 5's architecture-brief §3 disposition 1
        ("Server component — not supported" leaf in sidebar with explicit
        note) refines this; v1 ships with the inline-tile fallback.
      - **The `from-supabase.ts` registry builder uses single-level
        folders** (one folder per unique `folder_path`). Nested folder
        hierarchy reconstruction from path-parts is a Step 5 polish; v1
        flat-by-direct-parent reads correctly for dogfood + REV-Plugin.
      - **The `team` + `user` fields on the runtime Registry are stub
        objects** (`{id: "", name: "", plan: ""}` / `{name: "", email:
        ""}`). The dashboard nav avatar already binds to
        supabase.auth.getUser() (PR2); the team-chip surfaces are demo-
        era. Stubs are safe because no v1 sidebar consumer dereferences
        these fields critically.
      - **Iframe re-mount on selection change is the React `key={manifest.
        id}`** — every selection tears down + remounts the iframe
        (correct semantically; no stale postMessage state across
        selections). The bundle re-imports each time. Browser caches
        kick in for repeated visits to the same manifest; signed URL
        caching is bounded by the 15-min TTL.

      Pre-existing, not yours to fix:
      - `[branch]` vs `[...branch]` slug routing; non-unique slug scheme
        (v1-safe); `pnpm lint` fails on PR2's nav-avatar.tsx (missing
        @next/eslint-plugin-next) — `next build` is the real gate.
    </known-risks>

    <next>
      PR8 = Step 4.4 (Realtime stale-viewer — small tail). Replace
      `apps/web/components/live/app-shell/stale-viewer-trigger.tsx`'s 30s
      setTimeout with a `supabase.channel('instance:${id}').on('postgres_
      changes', { table: 'instances', filter: 'id=eq.${id}' })`
      subscription watching last_synced_commit_sha changes. Fires the
      existing warning-toast banner when the sha drifts from the viewer's
      session sha. ~30 lines, one file modified. Owner approved the
      two-PR-one-session framing at PR6 hand-back; PR8 lands separately
      after PR7 is merged + pushed AND advisor approves.

      Step 5 (manifest auto-generation polish): provider auto-detect from
      `app/layout.tsx`, `canvas.providers.tsx` fallback, `Component.
      canvas.tsx` per-component overrides, failure-mode dispositions
      (architecture-brief §3 cases 1–7 — incl. the sidebar "Server
      component — not supported" leaf that PR7 ships inline as a canvas
      tile), support-matrix connect-gate (Tailwind v3 / Next 15 must be
      REFUSED at connect — REV-Plugin proved this gate is load-bearing),
      stale-instance reconciler (every N hours), node_modules cache LRU
      eviction, optional `entryExportName` field on BuildManifest if
      non-PascalCase / re-export patterns emerge in real customer repos
      (PR7's heuristic export discovery is the hedge), nested folder
      hierarchy in the sidebar tree, persisted globals_css_key on
      `instances` if list-cost becomes measurable.

      R7/R9 = coordinated hosted cutover (Railway deploy + GitHub App
      Setup URL + Webhook URL + CORS lock + custom-domain DNS, incl.
      `preview.usemount.dev` for D1 cross-origin defense-in-depth).
      Worth doing as one coherent gate; PR7's iframe sandbox + CSP
      already enforce the JS-level boundary so D1 cross-origin is a
      defense-in-depth bonus, not a v1 blocker.

      Before PR8: confirm PAT was deleted in Supabase dashboard;
      Realtime subscription needs no migration (the channel infrastructure
      is enabled by default on Supabase).
    </next>
  </pr>

  <pr id="8" branch="feat/migration-step-4.4" base="staging" covers="Step 4.4"
      verified="builds+harness-live+no-regression+boot-smoke" date="2026-05-20">
    <secrets-policy>Session-only Supabase PAT supplied by the owner to
      apply 0004_realtime_publication.sql; staged to /tmp/usemount-sb-pat
      mode-600, used only via Management API POST /database/query, shredded
      at hand-back. Owner deletes the PAT in the Supabase dashboard at
      done-report (R2). Verify-realtime harness writes one sentinel
      instances row (TEST_INSTALL_ID=999_999_999_961, branch "test/pr8-
      realtime") and tears it down via CASCADE on repo_connections delete
      in a finally block.</secrets-policy>

    <correction pr="7">
      The PR7 `<next>` clause predicted "Realtime subscription needs no
      migration (the channel infrastructure is enabled by default on
      Supabase)." That's wrong on a v2-era Supabase project — the
      `supabase_realtime` publication ships EMPTY (no public.* tables); a
      channel subscribed to `postgres_changes` on `public.instances`
      enters SUBSCRIBED but never receives an event. PR8 includes a tiny
      0004 migration to add `public.instances` to the publication —
      verified empirically below.
    </correction>

    <decisions>
      <decision id="publication-mode" name="how to register public.instances"
                answer="ALTER PUBLICATION ADD TABLE (0004 migration)">
        The standard Supabase pattern. Idempotent guarded ADD via DO block
        so re-applying the migration is a no-op. RLS-gating on the
        receiving side is unchanged (the existing instances_select_policy
        from PR2 already restricts visibility to workspace members).
        Considered but rejected: (a) enabling Realtime via the Supabase
        dashboard toggle (non-reproducible, not in migration history; the
        owner asked for migration files only); (b) `FOR ALL TABLES` on
        the publication (over-broad — only instances needs to be
        Realtime-watched in v1).
      </decision>
      <decision id="filter-format" name="channel filter" answer="id=eq.<uuid>">
        The Realtime postgres_changes `filter` syntax. UUID columns work
        verbatim. Verify-realtime confirms the filter delivers exactly
        the targeted row's UPDATE events (no cross-row leakage). The
        browser StaleViewerTrigger uses the same filter form.
      </decision>
      <decision id="sha-baseline" name="how the trigger detects 'changed'"
                answer="ref-captured initialSha + per-event compare">
        StaleViewerTrigger captures `initialSha` at mount and stores it
        in a ref. On each UPDATE event, compares `payload.new.last_synced_
        commit_sha` to the ref; if different (and non-null), fires the
        toast AND updates the ref to the new sha so subsequent changes
        re-trigger. `initialSha == null` (instance never built) is a
        valid baseline — the first non-null sha triggers the toast (the
        "your first sync just completed" path).
      </decision>
    </decisions>

    <audit-findings step="0a">
      The PR7 audit + 0003 RPC live re-verification carried forward into
      this session (PR8 cuts from staging at `5e21843` — the PR7 merge).
      0002 dedup index, 0003 SECURITY DEFINER lease RPC, build_status
      enum, component-artifacts bucket, all PR6/PR7 surface unchanged.
      Brand-WIP files (4 modified + 2 deleted + 4 untracked) travelled
      via native git through the PR7 merge AND the PR8 branch cut without
      being staged.
    </audit-findings>

    <step-4.4 title="Realtime stale-viewer">
      <db>
        NEW supabase/migrations/0004_realtime_publication.sql — idempotent
        guarded `ALTER PUBLICATION supabase_realtime ADD TABLE
        public.instances`. Applied via Management API POST /database/query;
        verified live: `pg_publication_tables` row =
        `{pubname=supabase_realtime, schemaname=public, tablename=instances,
        attnames={id, workspace_id, repo_connection_id, branch, pinned,
        last_synced_commit_sha, last_synced_at, build_status, created_at}}`.
        `pg_publication.pubinsert/pubupdate/pubdelete/pubtruncate` all
        true (default Supabase publication operation set). Replica identity
        unchanged (`relreplident='d'`, default = primary key) — sufficient
        for INSERT + the NEW image of UPDATE/DELETE events; payload.old on
        UPDATE/DELETE carries pkey only, which is all the stale-viewer
        logic needs (it inspects payload.new.last_synced_commit_sha).
      </db>
      <code>
        MOD apps/web/components/live/app-shell/stale-viewer-trigger.tsx —
        the 30s setTimeout demo replaced with a
        `supabase.channel('instance:&lt;id&gt;').on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'instances',
        filter: 'id=eq.&lt;id&gt;' })` subscription. `initialSha` captured
        from props at mount and stored in a ref; per-event comparison
        triggers the existing warning-tone toast (architecture-brief §3
        Stale viewer detection prose preserved verbatim — title "This
        branch has an update", action "Refresh", duration: Infinity).
        Cleanup via `supabase.removeChannel(channel)` on unmount. If
        instanceId is undefined (legacy /playground mounts), no
        subscription is created and the component renders null silently.

        MOD apps/web/components/live/app-shell/app-shell.tsx — threads
        instance.instanceId + instance.lastSyncedCommitSha into
        StaleViewerTrigger. AppShellInstance interface gains
        `lastSyncedCommitSha?: string | null` (PR7 had everything except
        the sha — PR8 carries it for the baseline compare).

        MOD apps/web/app/[workspace]/[repo]/[branch]/page.tsx — extends
        the server-side instance fetch to also select last_synced_commit_
        sha; threads it through into the AppShell instance prop. RLS
        unchanged (the row is gated by instances_select_policy).

        NEW apps/api/scripts/verify-realtime.ts — 5-case in-process
        harness. Subscribes via supabaseAdmin (service-role; bypasses RLS
        on receive — the stronger end-to-end proof than the dashboard's
        Realtime inspector). Sentinel ids: TEST_INSTALL_ID=999_999_999_961.
        Cases: (1) channel reaches SUBSCRIBED within 7s, (2) instances
        UPDATE succeeds, (3) postgres_changes UPDATE event received
        within 7s of the UPDATE, (4) payload.new.last_synced_commit_sha
        matches the value the test wrote, (5) removeChannel cleans up.
        Teardown via repo_connections CASCADE delete.

        MOD apps/api/package.json — added `verify:realtime` script.

        MOD migration-plan.md — `<pr id="8">` migration-log entry +
        small correction on PR7's "no migration needed" claim.
      </code>
    </step-4.4>

    <deviations>
      - Migration is a guarded `DO $$ ... IF NOT EXISTS ... ALTER ... END
        $$;` (idempotent on re-apply), not a bare `ALTER PUBLICATION ...
        ADD TABLE ...;` (which throws SQLSTATE 42710 on a second apply).
        Doesn't change the end state; protects against double-apply if
        the migration ever lands twice.
      - Verify-realtime smoke uses the service-role admin client. The
        browser path uses the user's session client where RLS gates
        receive; both share the publication infrastructure so a service-
        role-side pass proves the wire works at the table level. A
        live browser-session smoke fires when the first real instance is
        viewable post-R7/R9.
      - The architecture-brief.md prose for Step 4.4 specifies "on
        `last_synced_commit_sha` change". PR8 implements this via per-
        event compare in JS rather than a server-side row filter, because
        Realtime's `filter` clause supports column-equality predicates
        but not "column changed". The JS-side compare is equivalent in
        behavior and adds zero ongoing cost (no extra DB roundtrips).
    </deviations>

    <verification gate="PR8" result="PASS">
      verify-realtime harness (live hosted DB + live Realtime): 5/5 PASS.
      Concretely:
      - Channel reaches SUBSCRIBED via the service-role admin client.
      - instances UPDATE writes the new last_synced_commit_sha.
      - postgres_changes UPDATE event arrives within ~1s of the UPDATE
        (post-publication-refresh; see operational-note in known-risks).
      - Event payload.new carries the exact sha the harness wrote.
      - removeChannel cleans up both client and server-side handles.
      Teardown clean: leftover_conns=0.

      0004 application live-verified via Management API:
      `pg_publication_tables` returns
      `{public, instances, attnames={id, workspace_id, repo_connection_id,
      branch, pinned, last_synced_commit_sha, last_synced_at,
      build_status, created_at}}`. Re-apply of the migration is a
      confirmed no-op (DO block IF NOT EXISTS guard fires).

      No-regression: verify-iframe (PR7, 38 cases) PASS;
      verify-push-webhook (PR5, 12 cases) PASS; verify-build-worker
      (PR6, 14 cases) PASS — all three unchanged.

      Builds GREEN: pnpm --filter @usemount/shared build (tsc -b) clean;
      pnpm --filter @usemount/api build (tsc -b) clean; pnpm --filter
      @usemount/web exec tsc --noEmit clean; pnpm --filter @usemount/web
      build (next build) — `✓ Compiled successfully`, 9 static pages,
      route table unchanged from PR7 (incl. `ƒ /preview/[manifestId]`).

      Port-boot smoke (PR5/PR6/PR7 pattern): PORT=4011, both
      `[worker:local-...] startup` AND `usemount.dev API running on port
      4011` lines, `/health → {"ok":true}` HTTP 200, SIGTERM →
      `[main] SIGTERM — shutting down` → `[worker:...] explicit stop —
      finishing current job, then exiting`, clean exit.

      Brand-WIP files (4 modified + 2 deleted + 4 untracked) untouched
      across PR7 merge + PR8 branch cut + PR8 commit.

      NOT exercised (deferred, R7/R9): a live browser session with a
      real session cookie subscribing to the channel. The service-role
      smoke proves the table-side wiring; the user-session path uses the
      same publication + Realtime infrastructure with RLS gating.
    </verification>

    <known-risks>
      Carry-forward (PR3/PR4/PR5/PR6/PR7): R1 two-app footgun, R7
      apps/api never deploy-verified, R9 cors('*') + GitHub App URLs
      unset + D1 same-origin iframe. All unchanged from PR7.

      PR8-introduced:
      - **Realtime worker refresh delay** — after adding a table to
        `supabase_realtime`, the Realtime server can take a short window
        (observed ~10-30s on this project) to pick up the change. During
        that window, channels subscribe successfully but events don't
        fire. The verify-realtime harness initially failed and passed
        after a 30s wait. Operational implication: don't expect Realtime
        to start delivering immediately after R7/R9 first applies the
        migration. v1 acceptable — a one-time settle window at deploy.
      - **Per-event toast on every sha change** — the trigger fires
        once per UPDATE that drifts the sha. Rapid successive builds
        (multiple pushes in quick succession) trigger multiple toasts.
        sonner replaces in place so the UX collapses to one visible
        toast; if the user dismisses then a new sha arrives, a new
        toast appears. v1 acceptable.
      - **REPLICA IDENTITY DEFAULT** on public.instances — payload.old
        on UPDATE/DELETE events carries only the primary key. v1's
        stale-viewer logic only reads payload.new.last_synced_commit_sha
        so this is fine; if a future feature needs old non-pkey columns,
        upgrade to FULL via a separate migration.
      - **Service-role subscriber bypass on the harness path** — the
        verify-realtime harness uses the admin client which bypasses
        RLS. The browser path is RLS-gated on receive; this is desired
        (only workspace members see their own instance's events). A
        live browser session smoke awaits R7/R9.
      - **No retry / exponential backoff** on channel disconnects.
        Supabase's JS client has built-in reconnect heuristics; v1
        relies on those. If reliability issues surface in production,
        wrap with a custom reconnect supervisor (Step 5+).

      Pre-existing, not yours to fix:
      - `[branch]` vs `[...branch]` slug routing; non-unique slug
        scheme (v1-safe); `pnpm lint` fails on PR2's nav-avatar.tsx
        (missing @next/eslint-plugin-next) — `next build` is the real
        gate.
    </known-risks>

    <next>
      Step 4 (first end-to-end sync) is now COMPLETE — PR5 closed 4.1,
      PR6 closed 4.2, PR7 closed 4.3, PR8 closed 4.4.

      Step 5 (manifest auto-generation polish): provider auto-detect
      from `app/layout.tsx`, `canvas.providers.tsx` fallback,
      `Component.canvas.tsx` per-component overrides, failure-mode
      dispositions (architecture-brief §3 cases 1–7), support-matrix
      connect-gate (Tailwind v3 / Next 15 REFUSED at connect — REV-Plugin
      proved this gate is load-bearing), stale-instance reconciler
      (every N hours), node_modules cache LRU eviction. PR7-deferred
      polish: optional `entryExportName` field on BuildManifest,
      nested folder hierarchy in the sidebar, persisted globals_css_key
      on instances if list-cost becomes measurable, theme inheritance
      (one-line: `theme` in HostToIframe.init + bootstrap sets
      `document.documentElement.dataset.theme`).

      R7/R9 = coordinated hosted cutover (Railway deploy + GitHub App
      Setup URL + Webhook URL + CORS lock + custom-domain DNS, incl.
      `preview.usemount.dev` for D1 cross-origin defense-in-depth).
      First hosted run will exercise the worker loop on Railway, the
      real GitHub clone leg via install token, the iframe sandbox
      enforcement in a real browser, the Realtime channel from a real
      user session, and the publication on a clean hosted Postgres.
      Worth doing as one coherent gate; the build-up to it is
      thoroughly local-verified now.

      Before R7/R9: confirm PAT was deleted in Supabase dashboard;
      review the consolidated PR7+PR8 known-risks for any items the
      cutover should explicitly cover (D1 cross-origin subdomain
      coordination is the biggest one).
    </next>
  </pr>

  <pr id="9" branch="feat/migration-step-5.1" base="staging" covers="Step 5.1"
      verified="builds+harness+no-regression+boot-smoke" date="2026-05-20">
    <secrets-policy>No Management API or live DB writes required —
      support-matrix.ts is pure and the verify-connect-gate harness is
      in-process. Owner provided a session-only Supabase PAT for the
      STEP 0a audit (live `pg_publication_tables` re-check of 0004
      from PR8 was offered but skipped — the PR8 verify-realtime pass
      this session is the stronger live proof). PAT staged to
      `/tmp/usemount-sb-pat` mode-600 for the session, shredded at
      hand-back. Owner deletes the PAT in the Supabase dashboard at
      done-report (R2).</secrets-policy>

    <decisions>
      <decision id="scope" name="PR9 sub-PR within Step 5"
                answer="(a) connect-gate only; PR10 reconciler offered at done-gate">
        Architecture-brief defines six Step 5 sub-PRs: (a) connect-gate,
        (b) provider auto-detect, (c) canvas.providers.tsx, (d)
        Component.canvas.tsx, (e) reconciler, (f) RSC sidebar entries.
        Recommended ordering = a → e → b+c → d → f. Owner picked
        "medium scope" at kickoff. Per advisor: treat PR9 = connect-gate
        ALONE as the contract; surface PR10 (reconciler) as an explicit
        check at done-gate, don't pre-bundle. This entry covers (a)
        only; PR10 is a separate later commit + merge + push if owner
        approves at hand-back.
      </decision>
      <decision id="failure-surface" name="how to render gate refusal"
                answer="reuse existing error alert with multi-line copy">
        Owner clarified at kickoff that an "unsupported stack" refusal
        and a "bug/network" failure are completely different outcomes,
        and asked for the simplest path for v1 (proper failure-screen
        UI is a later design pass). Backend distinguishes the two via
        response shape — 422 + structured violations (renderable) for
        matrix mismatch, 502 with `{message}` for Octokit/network
        errors. Frontend catch branches on `e.body.kind === 'unsupported'`
        and formats violations into the existing error alert via
        `whiteSpace: pre-line`. Zero new components; the structured
        backend response keeps a future UI revision cheap.
      </decision>
      <decision id="data-source" name="how to learn the customer's stack"
                answer="package.json via GitHub App contents:read API">
        Only sane choice — authoritative (matches what the build worker
        would see at install time), uses the existing PR3 permission,
        one round-trip. Considered + rejected: parsing a future
        `mount.config.ts` (doesn't exist yet, net-new convention),
        trial build (burns worker cycles for what's a metadata-only
        question).
      </decision>
      <decision id="matrix" name="which checks the gate enforces"
                answer="all five hard checks (architecture-brief §17–73)">
        React ≥19, (Next ≥16 OR Vite ≥5), Tailwind ≥4, TypeScript ≥5,
        a lockfile present. Owner was hesitant ("does the version
        really matter?") — advisor confirmed each check prevents a
        concrete failure mode: Tailwind v4 is load-bearing for the
        worker CSS pipeline (REV-Plugin spike proved v3 fails); the
        lockfile is required for package-manager auto-detect; TS 5+
        for compiler-API AST correctness on PR6 introspection; Next
        ≥16 / Vite ≥5 for app-shape assumptions in introspection;
        React ≥19 for forward-compat with the iframe ESM runtime.
        Soft-warn on unsupported CSS strategies is OUT of v1.
      </decision>
      <decision id="copy" name="violation message tone"
                answer="explicit `required (you have found)` per violation">
        Owner-confirmed at kickoff (D5 verbatim selection in the
        ask-user-question preview). The "you have X" line is honest
        delivery of the architecture-brief promise ("clear 'not yet
        supported' message at connect time, not a half-broken
        preview"). CTA buttons (Talk to us / Try a different repo)
        skipped for v1 per "simplest" — the user will design proper
        failure-screen UI later.
      </decision>
      <decision id="semver-lib" name="how to parse version strings"
                answer="custom regex; no new dep">
        `semver` is NOT a transitive dep of apps/api (`node -e
        require('semver')` throws Cannot find module). Per
        ~/.claude/CLAUDE.md "do not add new infra or dependencies
        unless asked," wrote a focused regex that extracts the major
        digit from a leading `[~^>=<\s]*v?(\d+)` and treats anything
        else (`workspace:*`, `git+ssh://…`, `npm:react@…`, `link:…`,
        etc.) as `unparseable`. 13 extractMajor-shape cases in the
        harness — every realistic real-world version string the
        regex needs to handle.
      </decision>
    </decisions>

    <audit-findings step="0a">
      Re-verified PR7 + PR8 + carry-forward PR5/PR6 via parallel
      Explore agents + direct reads of the files the prior agent
      called BLOCKER on. Net: 2 small NITs, no blockers; per
      ask-user-question owner chose to defer the NIT cleanup to a
      separate small follow-up (not bundle into PR9).

      OK across the board:
      - PR8 stale-viewer-trigger: useRef baseline, removeChannel
        cleanup, sha-comparison handles null baseline, toast fires on
        non-null differing sha — all four checks pass.
      - PR8 0004 migration: idempotent guard present; verify-realtime
        5/5 passes on solo run this session.
      - PR7 /preview route: UUID validation, RLS-gated fetch via
        server client (not admin), kind validation, artifact_url
        validation, per-request nonce via randomBytes(16), CSP
        directive set complete, referrer-policy: no-referrer.
      - PR7 iframe-html.ts: jsonForScript escape, buildCsp directives,
        bootstrap event.source check, pickComponent heuristic,
        error/unhandledrejection forwarding.
      - PR7 iframe-mount.tsx: event.source === contentWindow,
        propsRef, key={renderableManifest.id} on parent
        stage-content.tsx:163 (audit confirmed parent owns lifecycle).
      - PR7 preview-runtime/*.mjs: 4 files present, ~216 KB total.
      - PR7 shared/{manifest,iframe-protocol,synthesize-defaults}.ts:
        D2 collapse correct, protocol version 1, type guards,
        synthesizeDefaultProps covers all 9 D1 row kinds.
      - PR7 from-supabase.ts: registry build, manifest map with
        synthesized defaults, error-fallback, partial-row tolerance.
      - PR7 verify-iframe + build-preview-runtime: scripts correct.
      - PR5/PR6 carry-forward: webhook HMAC + 401-before-parse, worker
        shutdownFlag + heartbeat + orphan sweep + build_status,
        0003 RPC SECURITY DEFINER + service_role-only EXECUTE.

      NIT 1 — `apps/api/scripts/verify-realtime.ts:212-220`: teardown
      deletes via repo_connections CASCADE (correct + safe) but the
      harness only LOGS the teardown step; there's no explicit
      `assert("leftover_conns === 0", ...)` post-deletion. Cleanup
      is correct by construction; the assertion is documentation-
      only. ~5 LOC fix. Deferred.

      NIT 2 — `apps/web/app/preview/[manifestId]/route.ts:133-142`:
      the error-response branch (renderErrorHtml) sets
      content-type/CSP/x-content-type-options but does NOT set
      `x-frame-options: SAMEORIGIN`. The happy-path branch does
      (line 127). Defense-in-depth gap; the error page renders only
      an "invalid manifest id" / "manifest not found" string, no
      iframe-able content, but consistency favors mirroring the
      success branch's headers. ~1 LOC fix. Deferred.

      Brand-WIP files (4 modified + 2 deleted + 4 untracked)
      travelled via native git through the PR8 merge + the
      feat/migration-step-5.1 branch cut without being staged.
    </audit-findings>

    <step-5.1 title="Connect-gate (support-matrix check at connect time)">
      <code>
        NEW apps/api/src/github/support-matrix.ts — pure logic. Reads
        a parsed package.json + a lockfile name, returns
        SupportMatrixViolation[] (empty = pass). Six fields:
        `package-json` (single root-cause when pkg null — skips the
        other 5 so the user gets one actionable line, not a wall of
        "absent"), `react`, `next-or-vite` (either-or check), `tailwind`,
        `typescript`, `lockfile`. Three reasons: too-old, absent,
        unparseable. extractMajor() handles `^19.0.0`, `~14.2.0`,
        `5`, `>=4.0.0 &lt;5.0.0`, `v19.0.0`, `19.0.0-rc.1`; rejects
        `git+ssh://…`, `workspace:*`, `npm:react@^17`, empty/null as
        unparseable. Zero IO, zero deps — testable in-process.

        NEW apps/api/src/github/fetch-package-json.ts — Octokit
        wrapper. `fetchRepoMeta(octokit, owner, repo, ref)` does ONE
        root listing (1 Octokit call) — pulls all root file names —
        then conditionally fetches package.json (1 more call only if
        present). Detects lockfile name in the same root listing. 1 MB
        sanity cap on package.json size. Returns
        `{ packageJson, lockfileName }`; on absent/oversize/parse-fail,
        leaves packageJson null and the matrix check surfaces a
        single `package-json: absent` violation.

        MOD apps/api/src/github/connections.ts — connect-gate inserted
        BETWEEN the 409 cross-workspace guard (existential check) and
        the repo_connections upsert (capability check ordering:
        existence → ownership → matrix → write). Two failure modes:
        (a) Octokit throws → `throw new HTTPException(502, {message:
        "Couldn't verify support — GitHub didn't respond. Try
        again."})`, (b) matrix mismatch → `return c.json({kind:
        "unsupported" as const, violations}, 422)`. The 422 path is
        the new structured response shape; everything else preserves
        the existing HTTPException pattern.

        MOD apps/web/lib/api/client.ts — extended `ApiError` with an
        optional `body?: unknown` field. apiFetch's error branch now
        parses application/json responses into `body` (and extracts
        `body.message` if present), keeping the existing text-only
        fallback for non-JSON errors. Backward-compatible — every
        existing caller still works against ApiError.message; the
        new field lets callers like the connect-form branch on
        `body.kind === "unsupported"` to render structured payloads.

        MOD apps/web/components/live/connect-repo-form/connect-repo-
        form.tsx — added an `isUnsupported` type guard and a
        `formatUnsupported` helper that turns the 422 violations
        array into multi-line D5 copy ("This repo isn't supported
        yet.\n\nusemount.dev requires:\n• React v19+ (you have
        v17.0.2)\n…"). The catch handler branches: 422 + unsupported
        body → formatted violations; other ApiError → existing
        "Connect failed (status). message"; non-ApiError → existing
        "Connect failed. Try again.". Existing error `&lt;p
        role="alert"&gt;` gains `whiteSpace: "pre-line"` so the
        newlines render. Zero new components.

        NEW apps/api/scripts/verify-connect-gate.ts — 39-case
        in-process harness. extractMajor() shape cases (13), happy
        paths (5 — Next, Vite, devDeps-only, future major versions,
        Vite-OK-overrides-Next-too-old either-or behavior), per-field
        refusals (10 — React too-old / missing / 18-boundary, Next
        14 / Vite 4 / neither, Tailwind 3 too-old, TS 4 too-old, no
        lockfile, React git+ssh unparseable), combined 5-axis refusal
        (6 — total count + per-field check), edge cases (5 — null
        pkg / non-object pkg / empty pkg / null deps / exact versions).
        Pure function harness — no DB, no Octokit. Sentinel range
        999_999_999_951/952 reserved for future PR9 cases that need
        live state.

        MOD apps/api/package.json — added `verify:connect-gate`
        script. No new deps.

        MOD migration-plan.md — this `&lt;pr id="9"&gt;` entry.
      </code>
    </step-5.1>

    <deviations>
      - **No new UI component**. The handoff plan anticipated a new
        `apps/web/components/live/connect-repo-form/unsupported-matrix.
        tsx` subcomponent. Owner picked "simplest for now" at D2
        kickoff; advisor agreed (structured backend response keeps
        future UI revision cheap). The existing error alert
        (lines 152-160) renders multi-line copy via `whiteSpace:
        pre-line`. ~50 LOC of new component avoided.
      - **No `semver` dep**. The npm `semver` package isn't a
        transitive of apps/api. Wrote a focused 1-line regex
        (`SEMVER_MAJOR_RE`) that handles every realistic version-
        string shape from real-world package.json files. Verified
        via 13 extractMajor cases in the harness.
      - **Root-listing optimization**. fetchRepoMeta does ONE
        `getContent("")` to learn both (a) whether package.json
        exists and (b) which lockfile is present, then conditionally
        ONE more `getContent("package.json")` if needed. 2 Octokit
        calls max on the happy path; 1 call if no package.json.
      - **No new field on the matrix for "next-15"**. The matrix
        treats Next ≥16 as the cut. Next 15 → too-old, no special
        case (the user just sees "Next.js v16+ or Vite v5+ (you
        have Next.js v15…)"). Could special-case 15 as a near-miss
        with a "we're working on 15 support" hint later; v1 keeps
        the message uniform.
      - **No live HTTP smoke this session**. Doing a real
        `/repo-connections` POST requires a Bearer token from a
        signed-in user + a real GitHub App install + a real
        package.json fetch through Octokit. The pure-function matrix
        logic is exhaustively covered (39/39); the route-handler
        integration (order-of-checks placement, 502 catch shape,
        422 structured shape, Buffer base64 decode in
        fetchRepoMeta) is small and uncovered. Owner can drive
        the live smoke during the hand-back by clicking through
        /connect against a Tailwind-v4 repo (happy path) and any
        old-Tailwind public repo (refusal path) — both via
        `next dev` against the existing local apps/api process.
        Deferred but documented.
    </deviations>

    <verification gate="PR9" result="PASS">
      verify-connect-gate harness: 39/39 PASS (pure function, instant).

      Builds GREEN:
      - `pnpm --filter @usemount/shared build` (tsc -b) clean.
      - `pnpm --filter @usemount/api build` (tsc -b) clean.
      - `cd apps/web &amp;&amp; pnpm exec tsc --noEmit` clean.
      - `cd apps/web &amp;&amp; pnpm exec next build` — `✓ Compiled
        successfully in 3.0s`, 10 routes intact incl. `ƒ /connect`,
        `ƒ /connect/callback`, `ƒ /preview/[manifestId]` (PR7),
        `ƒ /[workspace]/[repo]/[branch]`, middleware proxy.

      No-regression:
      - verify-iframe (PR7, 38 cases): PASS.
      - verify-push-webhook (PR5, 12 cases): PASS.
      - verify-realtime (PR8, 5 cases): PASS on solo run (parallel
        with build-worker hit the documented Realtime worker refresh
        window — see PR8 known-risks; re-ran solo, PASS).
      - verify-build-worker (PR6, 14 cases): 8/9 pass on the run
        attempted this session; case 9 (caseFail's setup
        leaseNextJob) fails because the user has 3 long-running
        `tsx watch src/index.ts` build worker processes active on
        this machine (started before this session). Pre-existing
        test precondition is "stop the dev workers before running
        the harness" — not a PR9 regression. PR9 doesn't touch the
        worker, lease RPC, or build_jobs schema. Documented in
        known-risks.

      Port-boot smoke: PORT=4013, observed
      `[worker:local-...] startup`, `usemount.dev API running on
      port 4013`, SIGTERM →
      `[main] SIGTERM — shutting down` →
      `[worker:...] explicit stop — finishing current job, then
      exiting`, clean shutdown (exit 143 = SIGTERM-terminated).

      Brand-WIP files (4 modified + 2 deleted + 4 untracked)
      untouched across PR8 merge + PR9 branch cut + PR9 commit.

      NOT exercised (deferred — owner-runnable during hand-back):
      - Live HTTP `/repo-connections` POST end-to-end (requires
        Bearer + real GitHub install + real package.json fetch).
        Owner can run `next dev` against the existing apps/api
        process and click through /connect on a Tailwind-v4 repo
        (happy path expected: redirect to /[workspace]/[repo]/main)
        and any old-Tailwind public repo (refusal expected:
        formatted 422 violations in the existing error alert).
    </verification>

    <known-risks>
      Carry-forward (PR3/PR4/PR5/PR6/PR7/PR8): R1 two-app footgun,
      R7 apps/api never deploy-verified, R9 cors('*') + GitHub App
      URLs unset + D1 same-origin iframe. All unchanged from PR8.
      PR8 R-Realtime-settle window also still applies on R7/R9
      first-deploy.

      PR9-introduced:
      - **Monorepo customers refused on root package.json**. v1
        reads the root package.json only. A pnpm/yarn/npm workspace
        root with no React/Next deps would be refused even if a
        child workspace is legitimately supported. Workspace-aware
        scan (read `workspaces` field, scan each child for the
        canonical React app) is a Step 5 follow-up.
      - **Verify-build-worker dev-worker precondition**. The PR6
        harness fails case 9 when other `tsx watch src/index.ts`
        worker processes are running on the host because they
        compete for the lease. Not new in PR9 — pre-existing test
        precondition documented now. Operational fix: `pkill -f
        "tsx watch src/index.ts"` before running the harness, or
        accept the partial pass on a dev machine.
      - **2 audit NITs deferred to a future follow-up PR**:
        verify-realtime teardown leftover-conns assert (~5 LOC) +
        /preview error-CSP x-frame-options consistency (~1 LOC).
        Owner chose at kickoff to defer rather than bundle into PR9.
      - **No durable record of connect-gate refusals**. When the
        gate refuses a customer, the 422 response is the only
        artifact — nothing is logged to Postgres / Sentry / etc.
        Without a refusal log we don't know what stacks people are
        trying to connect with, so investment direction (e.g.
        "should we add Tailwind v3 support?") is blind. Step 5
        polish; not blocking for v1.
      - **No "near-miss" hints**. Next 15 / TS 4.9 / React 18.3.1
        are presented identically to Next 12 / TS 3 / React 16
        ("too-old", same copy). A future polish could note "very
        close — Next 15 minor-bumped to 16 last quarter, upgrade
        is small" for the boundary cases. v1 ships uniform messages.
      - **No reconciler yet** (architecture-brief §11). Webhook
        delivery has the "Re-sync now" manual button (PR5+) but no
        every-2h reconciler comparing pinned-branch HEAD vs
        last_synced_commit_sha. PR10 is the natural follow-up,
        offered at hand-back per the kickoff D1 conversation.

      Pre-existing, not yours to fix:
      - `[branch]` vs `[...branch]` slug routing; non-unique slug
        scheme (v1-safe); `pnpm lint` fails on PR2's nav-avatar.tsx
        (missing @next/eslint-plugin-next) — `next build` is the
        real gate.
    </known-risks>

    <next>
      Step 5 sub-PRs still to ship (architecture-brief §3 + §11):
      - (e) Webhook reconciler — every-2h drift check via GitHub App
        + `build_jobs` insert. PR10 candidate; offered to owner at
        PR9 hand-back per the kickoff conversation.
      - (b) Provider auto-detect from `app/layout.tsx` — scan for
        known providers (next-themes, @emotion/react, @tanstack/
        react-query, etc.), emit `providers.auto.tsx` in the bundle,
        iframe wraps every component.
      - (c) `canvas.providers.tsx` fallback — repo-root file the
        worker copies into the bundle when the customer's provider
        is bespoke.
      - (d) `Component.canvas.tsx` per-component override — exported
        `controls` merge into / override the auto-generated panel.
      - (f) RSC sidebar disposition — promote PR7's `maybe-rsc` /
        `unsupported` inline tile to a sidebar greyed-out leaf with
        explicit "Server component — not supported" note
        (architecture-brief §3 disposition 1).

      PR7+PR8 audit-NIT cleanup (small standalone PR or bundled into
      a later sub-PR):
      - verify-realtime teardown leftover-conns assert.
      - /preview error-CSP x-frame-options consistency.

      PR9-introduced known-risks worth surfacing during R7/R9
      planning: monorepo-customer refusal (workspace-aware scan
      needed for org customers with monorepos), connect-gate
      refusal logging (decide table vs Sentry).

      R7/R9 still deferred (Railway + GitHub App URLs + CORS lock
      + custom-domain DNS + cross-origin preview subdomain). With
      Step 5 underway the system gets closer to "honest at scale" —
      every Step 5 sub-PR removes one "looks like our bug but is
      really an unsupported stack / missing provider / failed
      webhook" failure mode.

      Before R7/R9: confirm PAT was deleted in Supabase dashboard
      (this PR9 used the PAT only for the optional STEP 0a re-check
      that was skipped; shred + deletion still applies for hygiene).
    </next>
  </pr>

  <pr id="10" branch="feat/migration-step-5.2" base="staging" covers="Step 5.2 + 1 PR9 correction + 2 PR7/PR8 audit NITs"
      verified="builds+harness+no-regression+boot-smoke+tick-smoke" date="2026-05-20">
    <secrets-policy>No Management API or live DB writes required beyond
      the existing service-role harness pattern. No PAT requested or
      staged this session — PR10 is runtime additions (reconciler module
      + harness) and a small constant change (KNOWN_LOCKFILES). The
      service-role admin client (already in env) is sufficient for the
      live-DB verify-reconciler harness sentinels.</secrets-policy>

    <decisions>
      <decision id="scope" name="PR10 bundling: reconciler-only vs reconciler + audit fixes"
                answer="(A) bundled — reconciler + bun.lock + 2 deferred NITs">
        STEP 0a audit found one PR9-introduced false-negative
        (bun.lock missing from KNOWN_LOCKFILES — refuses real Bun-1.2+
        customers) and re-confirmed the 2 PR9 NITs deferred at PR9
        kickoff. All three are small (1 LOC + 5 LOC + 1 LOC) and
        the reconciler is ~250 LOC, so bundling stays within "focused
        sub-PR" guidance from the chain handover. Owner picked A at
        ask-user-question kickoff. Migration-log shape mirrors the
        existing &lt;correction pr="2"&gt; precedent: the bun.lock fix
        gets its own &lt;correction pr="9"&gt; clause inside this
        PR10 entry; the NITs are documented in &lt;step-5.2&gt; prose
        as defense-in-depth cleanup; the reconciler is the main scope.
      </decision>
      <decision id="fetchHead" name="how the reconciler harness verifies drift detection"
                answer="dependency-injected fetchHead seam — harness stubs without hitting real GitHub">
        Two options weighed: (a) call real GitHub via App Octokit against
        a public repo (realistic but flaky on rate limits / network
        blips), (b) accept a `fetchHead` injection point on
        `runReconciler({ fetchHead })` so the harness can stub it
        per-branch (clean, deterministic, no external dep). Advisor +
        kickoff-doc both recommended (b). Default `defaultFetchHead`
        wraps `octokit.repos.getBranch(...)` and discriminates 404
        (returns null — "branch deleted / install lost access", skip
        without erroring) vs other failures (throws — caller increments
        the per-instance errors counter and continues).
      </decision>
      <decision id="interval" name="reconciler scheduling: setInterval vs cron"
                answer="setInterval in-process at 2h, env-tunable, first tick +1min">
        setInterval is the cheapest v1 scheduler — Railway cron adds
        infra. Architecture-brief §11 specifies 2h. First tick fires
        ~1 min after startup so any drift accumulated while the
        process was down gets enqueued promptly (without slamming the
        process during boot). The interval + first-delay are env-
        tunable via `RECONCILER_INTERVAL_MS` and
        `RECONCILER_FIRST_DELAY_MS` so (i) operators can dial them
        without redeploys and (ii) the tick-smoke can prove the
        setTimeout chain at 2s. A `running` flag prevents two ticks
        in flight if a tick ever outlasts the interval (defensive at
        scale; can't happen at v1 timing).
      </decision>
      <decision id="disable-flag" name="reconciler enable: paired with worker or independent"
                answer="independent DISABLE_RECONCILER, mirroring DISABLE_BUILD_WORKER">
        Mirror PR6's flag pattern. Default = both on. Operator who
        wants worker-only (dev sandbox) sets DISABLE_RECONCILER=1;
        operator who wants reconciler-only (separate scheduler
        process) sets DISABLE_BUILD_WORKER=1. No automatic coupling —
        simpler contract, no surprise behavior.
      </decision>
      <decision id="dedup-23505" name="how the reconciler handles a race against push-webhook (and peer replicas)"
                answer="catch insErr.code === '23505', silent skip">
        Load-bearing on 0002's partial UNIQUE index
        `(instance_id, commit_sha) WHERE status IN ('queued','running')`.
        Reconciler-vs-push, reconciler-vs-self (multi-replica), and
        reconciler-vs-in-flight-build all surface as Postgres
        unique_violation on INSERT — caught and silently skipped (the
        existing active job will build the same SHA). The harness
        has a dedicated case re-running the reconciler against an
        already-enqueued row and asserting enqueued=0 + errors=0 + the
        existing row count stays at 1.
      </decision>
    </decisions>

    <audit-findings step="0a">
      Re-verified PR9 line-by-line (5 files, 39-case harness traced) +
      swept PR1–PR9 known-risks end-to-end per the owner's explicit
      hand-back framing ("look over any known-risks and security risks
      etc and evaluate the setup and find solutions"). Parallel Explore
      agent extracted every flagged item from `&lt;migration-log&gt;`
      clauses; direct reads confirmed the load-bearing security primitives
      against their source files.

      PR9 surface — confirmed clean:
      - support-matrix.ts: extractMajor regex covers `^19.0.0` / `~14.2.0`
        / `5` / `5.0.0` / `>=4 &lt;5` / `v19.0.0` / `19.0.0-rc.1`; rejects
        `git+ssh://…` / `workspace:*` / `npm:react@^17` / `link:./pkg`
        as unparseable. The 6-field check is correct (package-json
        short-circuit, either-or next-or-vite, presence-only lockfile).
      - fetch-package-json.ts: 1 MB cap, base64+JSON.parse try/catch,
        `pkg.data.type === "file"` guard, Array.isArray on root
        listing — all defensive. 2 Octokit calls max.
      - connections.ts: gate placement correct (between line 101 409
        cross-workspace and line 140+ upsert). 502 catch over the whole
        fetchRepoMeta block. 422 returns `{kind:"unsupported",
        violations}` matching the frontend type guard.
      - client.ts: ApiError.body backward-compat; content-type substring
        check correctly matches `application/json; charset=utf-8` AND
        `application/problem+json`. Text-only fallback preserved for
        non-JSON errors.
      - connect-repo-form.tsx: isUnsupported guard + formatUnsupported
        handle all 3 reasons (too-old / absent / unparseable). Catch
        ordering (422 + structured body → other ApiError → non-ApiError)
        correct.

      PR9 — one confirmed correction, see &lt;correction pr="9"&gt;
      below: `KNOWN_LOCKFILES` missing `bun.lock`.

      Cross-PR sweep (PR1–PR9 known-risks) — no blockers:
      - 0001 RLS: workspace policies via SECURITY DEFINER helpers
        (`is_workspace_member`, `is_workspace_owner`) so the policies
        are NOT recursive. apps/api service-role bypass is safe because
        `require-user.ts` enforces ownership in code
        (assertWorkspaceMember / assertWorkspaceOwner /
        assertInstallationOwnership).
      - 0002 dedup: partial UNIQUE on (instance_id, commit_sha) WHERE
        status IN ('queued','running'). Covers reconciler-vs-push +
        multi-replica + reconciler-vs-in-flight races for free —
        this is what makes PR10's "INSERT, swallow 23505" safe.
      - 0003 lease RPC: SECURITY DEFINER + SET search_path + REVOKE
        ALL FROM PUBLIC/anon/authenticated + GRANT EXECUTE service_role.
        Untouched in PR10.
      - 0004 publication: REPLICA IDENTITY DEFAULT (pkey-only payload.old).
        PR10 reconciler polls HEAD itself, doesn't depend on Realtime
        payload.old.
      - PR5 webhook: HMAC checked via x-hub-signature-256 (correct, NOT
        the deprecated SHA1 `x-hub-signature`), `timingSafeEqual`,
        length-guarded before constant-time compare, verify BEFORE
        JSON.parse. Rate-limit BEFORE HMAC verify (correct order — DoS
        first, forge after).
      - PR6 worker: lease + heartbeat + isStolen abort; per-component
        failures don't kill the job (kind='unsupported', job continues).
        node_modules cache LRU is a documented v1-accept; not a PR10
        concern.
      - PR7 iframe CSP: importmap points only at self-hosted
        `/preview-runtime/*.mjs`. `script-src 'self' 'nonce-…'
        https://&lt;storageHost&gt;`. `connect-src 'none'` blocks
        all fetch/XHR/WS exfiltration. `frame-ancestors 'self'`. The
        `style-src 'unsafe-inline'` exception is required by customer
        inline `style={{ ... }}` (documented v1 trade-off; not
        relaxable v1).
      - R1 two-app footgun: documented explicitly in auth.ts (the
        comment block lines 17-18). Architectural by design.

      Prioritised risk register (rolls forward to PR11 handover):
      - **HIGH**: bun.lock coverage gap — fixed in this PR via
        &lt;correction pr="9"&gt;.
      - **MEDIUM**: 2 deferred PR9 NITs — fixed in this PR (see
        &lt;step-5.2&gt; defense-in-depth section). Refusal logging
        (PR9), near-miss hints (PR9), monorepo refusal (PR9),
        node_modules LRU (PR6), multi-replica reconciler stampede
        (PR10-introduced; covered by 0002 today, polish later) — all
        Step 5/5.x polish, none blocking.
      - **LOW (R7/R9 gate)**: CORS lock, GitHub App Setup/Webhook
        URLs, custom-domain DNS, preview subdomain, Realtime
        first-deploy publication-settle window. Deferred by design
        per architecture-brief; do not unilaterally fix.

      Brand-WIP files (4 modified + 2 deleted + 4 untracked +
      design-philosophy/Design Purgatory/) untouched throughout
      audit + branch + commit.
    </audit-findings>

    <correction pr="9" date="2026-05-20">PR9's `apps/api/src/github/
      fetch-package-json.ts` `KNOWN_LOCKFILES` array recognised
      `bun.lockb` (legacy binary) but NOT `bun.lock` (the text-based
      JSONC format Bun 1.1.39 introduced and Bun 1.2+ made the default
      for `bun init`). Source: Bun docs at
      `https://github.com/oven-sh/bun/blob/main/docs/pm/lockfile.mdx`
      — "1.2.0+ it is the default format used for new projects". By
      today (2026-05-20) the text-default has been default for ~16
      months; a freshly-`bun init`'d customer ships `bun.lock` (not
      `bun.lockb`) and would have been refused at the connect-gate
      with `lockfile: absent` despite having a valid lockfile. False
      negative. Fix: added `"bun.lock"` to KNOWN_LOCKFILES (before
      `bun.lockb` so the modern default is preferred) + 1 new harness
      case in verify-connect-gate.ts asserting `lockfileName: "bun.lock"`
      passes the matrix on an otherwise-supported stack. Brings the
      harness to 40/40 (was 39). Also updated the user-facing
      "required" copy in support-matrix.ts to list `bun.lock, or
      bun.lockb` so the refusal message is honest about both formats.
    </correction>

    <step-5.2 title="Webhook reconciler (every-2h drift check)">
      <code>
        NEW apps/api/src/build/reconciler.ts — pure async
        `runReconciler({ fetchHead?: FetchHead })` plus a recurring-tick
        scheduler `startReconcilerLoop()` exported for mounting in
        src/index.ts. The pure function loops active+pinned
        repo_connections+instances, fetches each pinned branch's live
        HEAD via the App Octokit, INSERTs build_jobs(status='queued')
        on drift, swallows 23505 (dedup against push-webhook + peer
        replicas + in-flight builds via 0002's partial UNIQUE),
        catches per-instance errors so one bad repo doesn't kill
        the tick. Returns {checked, enqueued, errors}. The scheduler
        wraps the pure function in setTimeout-chain (not setInterval,
        so a slow tick can't overlap) with `running` flag,
        `stopped` flag, and a `done` Promise for clean shutdown.
        FIRST_TICK_DELAY_MS + TICK_INTERVAL_MS are env-tunable via
        `RECONCILER_FIRST_DELAY_MS` + `RECONCILER_INTERVAL_MS`
        respectively (defaults 60s + 2h per architecture-brief §11);
        the tick-smoke proves the chain at 2s+2s.

        MOD apps/api/src/index.ts — mounts startReconcilerLoop()
        alongside the existing worker. DISABLE_RECONCILER=1 flag
        mirrors DISABLE_BUILD_WORKER (independent — operator can run
        either subsystem alone). Shutdown cascade: SIGTERM →
        reconciler.stop() (clears the timer) + worker.stop() (sets
        shutdown flag) → await worker.done → await reconciler.done
        → httpServer.close().

        NEW apps/api/scripts/verify-reconciler.ts — in-process harness
        against the live service-role DB. Sentinel range
        999_999_999_941 / 942 / 943 (distinct from PR5/PR6/PR7/PR8/PR9).
        20 cases across 3 scenarios:
          - case A (drift / no-drift / 404 / throw / filter): seeds an
            active connection with 5 instances (drift + nodrift +
            unpinned + 404 + throw) + an inactive connection with 1
            pinned instance. Stubs fetchHead per branch. Asserts
            checked=4, enqueued=1, errors=1; asserts fetchHead NEVER
            called for unpinned + inactive-connection instances;
            asserts build_jobs rows present only for the drift
            instance.
          - case B (23505 swallow): re-runs the reconciler with the
            drift's row still queued from case A. Asserts enqueued=0,
            errors=0 (23505 is not an error), and the existing row
            count stays at 1. Proves the multi-replica + reconciler-vs-
            push race resolution.
          - case C (zero active connections): deactivates everything,
            re-runs. Asserts all counters zero and fetchHead never
            called. Proves the empty-state degenerates cleanly.
        Teardown: CASCADE on repo_connections + leftover-conns assert
        (same pattern as the PR8-NIT fix below).

        MOD apps/api/package.json — added `verify:reconciler` script.
        No new deps; reconciler reuses `@octokit/rest` already in
        dependencies (PR3).

        Defense-in-depth NIT cleanup (deferred from PR9 audit):

        MOD apps/web/app/preview/[manifestId]/route.ts — added
        `x-frame-options: SAMEORIGIN` to the errorResponse() headers
        so it mirrors the success branch (line 127). The error page
        renders only a short error string (no iframe-able content) so
        the practical risk was nil, but the consistency is documentation-
        friendly for future readers + scanners. ~1 LOC.

        MOD apps/api/scripts/verify-realtime.ts — added explicit
        `assert("teardown left no sentinel repo_connection", count===0)`
        after the CASCADE delete. The CASCADE is correct by
        construction; the assertion is defense-in-depth against a
        future FK-shape change silently leaving orphans behind for
        the next harness run to trip on. Brings verify-realtime to
        6/6 (was 5). ~12 LOC including the count query.

        MOD apps/api/scripts/verify-connect-gate.ts — added 1 new case
        asserting bun.lock passes (the &lt;correction pr="9"&gt; fix
        above). 40/40 (was 39).

        MOD migration-plan.md — this `&lt;pr id="10"&gt;` entry.
      </code>
    </step-5.2>

    <deviations>
      - **Env-tunable interval constants**. Not strictly required by
        the kickoff scope; added because the scheduler chain can't be
        proven end-to-end at the 60s + 2h defaults without burning
        wall-clock. The env-tunable + fast 2s+2s tick-smoke is the
        minimum proof that the setTimeout chain actually loops. Side
        benefit: operators can dial the interval without redeploying.
      - **No new component / no new migration**. Matches PR9's
        "no UI component" deviation; the reconciler is a runtime
        addition only, no schema change (build_jobs.commit_sha was
        already non-null per 0001).
      - **No-`semver` dep continued**. Same posture as PR9 — the
        reconciler only compares SHA strings (textual equality), no
        version logic.
    </deviations>

    <verification gate="PR10" result="PASS">
      verify-reconciler: 20/20 PASS (new harness).
      verify-connect-gate: 40/40 PASS (was 39, +1 bun.lock case).
      verify-realtime: 6/6 PASS (was 5, +1 teardown assert; first
        run on this branch hit the PR8-documented publication-refresh
        window — 7s event timeout, see PR8 &lt;known-risks&gt; — solo
        re-run after a ~10s settle passed cleanly including the new
        teardown assert).
      No-regression: verify-iframe 38/38, verify-push-webhook 12/12,
        verify-build-worker 14/14 (full pass this session — no
        leftover `tsx watch` dev workers; the PR9-documented
        precondition was cleared via `pkill -f "tsx watch src/index.ts"`
        before re-running).

      Builds GREEN:
      - `pnpm --filter @usemount/shared build` (tsc -b) clean.
      - `pnpm --filter @usemount/api build` (tsc -b) clean.
      - `cd apps/web &amp;&amp; pnpm exec tsc --noEmit` clean.
      - `cd apps/web &amp;&amp; pnpm exec next build` — Compiled
        successfully in 3.1s, 10 routes intact incl. ƒ /connect,
        ƒ /connect/callback, ƒ /preview/[manifestId],
        ƒ /[workspace]/[repo]/[branch], middleware proxy.

      Port-boot smoke: PORT=4013, observed
      `[worker:local-...] startup`, `[reconciler] startup (first tick
      in ~60s, then every 7200s)`, `usemount.dev API running on port
      4013`, SIGTERM → `[main] SIGTERM — shutting down`,
      `[worker:...] explicit stop — finishing current job, then
      exiting`, clean shutdown. (Caveat: when backgrounded under tsx
      watch via `pnpm dev`, the tsx wrapper sometimes detaches the
      child node process so the final `[worker] loop exited` /
      `[main] shutdown complete` lines don't always flush before
      tsx tears down stdout. On Railway, SIGTERM goes straight to
      the node process — no tsx wrapper — and the full drain
      sequence is observable. Not a regression.)

      Tick smoke: RECONCILER_FIRST_DELAY_MS=2000 +
      RECONCILER_INTERVAL_MS=2000 + DISABLE_BUILD_WORKER=1 +
      PORT=4015, observed
      `[reconciler] startup (first tick in ~2s, then every 2s)`,
      `usemount.dev API running on port 4015`, three successive
      `[reconciler] tick: 0 checked, 0 enqueued, 0 errors` lines,
      SIGTERM → `[main] SIGTERM — shutting down`, clean shutdown
      (exit 143). Proves the setTimeout chain actually fires
      repeatedly — the harness verifies runReconciler() correctness
      directly but bypasses the scheduler.

      Brand-WIP files (4 modified + 2 deleted + 4 untracked +
      design-philosophy/Design Purgatory/) untouched across the
      branch cut + commit + this docs commit.

      NOT exercised (deferred — owner-runnable):
      - Live GitHub HEAD fetch via the default fetchHead against a
        real installation. The GitHub App still has 0 installations
        (per PR9 known-risk); the moment the owner installs the App
        and connects a real repo, the next reconciler tick (within
        2h) will hit `octokit.repos.getBranch(...)` on a real branch.
        Until then, the live-DB harness with the stubbed fetchHead
        is the strongest proof.
    </verification>

    <known-risks>
      Carry-forward (PR3/PR4/PR5/PR6/PR7/PR8/PR9): R1 two-app footgun,
      R7 apps/api never deploy-verified, R9 cors('*') + GitHub App
      URLs unset + D1 same-origin iframe + Realtime first-deploy
      publication-settle window. PR9 monorepo-refusal + no-refusal-
      logging + no-near-miss-hints carry forward (Step 5 polish).
      All unchanged from PR9.

      PR10-introduced:
      - **Multi-replica reconciler stampede mitigated, not eliminated**.
        At post-R7/R9 multi-replica scale, every replica fires the
        same HEAD-fetch sweep every 2h. 0002's partial UNIQUE catches
        the duplicate INSERTs (covered + tested in case B), but the
        wasted GitHub API calls aren't free. Mitigation: add jitter
        to FIRST_TICK_DELAY_MS per replica via a small random delay
        derived from `RAILWAY_REPLICA_ID`. Step 5.x polish; v1 is
        fine.
      - **Local-dev reconciler noise**. After the +60s first tick,
        every running `pnpm dev` will fire ticks against any local
        sentinel `active=true` repo_connections (PR8-realtime + PR10-
        reconciler sentinels are cleaned by teardown; the user's
        real /connect rows would also fire — but real rows mean a
        real install token, which works fine). For dev-without-DB
        scenarios, set `DISABLE_RECONCILER=1` alongside
        `DISABLE_BUILD_WORKER=1`. Worth a one-liner in
        `apps/api/.env.example` if/when that file is touched next.
      - **Persistently-404'd instances retried every 2h forever**.
        If a branch is deleted (or the App loses access on that one
        branch), the reconciler logs `no head for ${repo}#${branch}`
        and skips. It doesn't deactivate the instance row or pause
        the per-instance check. Net: every 2h that 404 fires again.
        Polish (Step 5.x): on N consecutive 404s, deactivate the
        instance row or flip the pinned flag off. Not blocking;
        observable in logs.
      - **No `RECONCILER_INTERVAL_MS` / `RECONCILER_FIRST_DELAY_MS`
        in apps/api/.env.example**. Defaults are production-correct
        (60s + 2h) so no production deploy is at risk; only the
        local-dev experience misses the tunables. Bundle with the
        DISABLE_RECONCILER doc one-liner above when that file
        is next touched.

      PR9-known-risks resolved this session:
      - **bun.lock false-negative refusal**: closed by
        &lt;correction pr="9"&gt; in this PR.
      - **2 audit NITs (verify-realtime teardown assert,
        /preview error-CSP x-frame-options)**: closed by the
        defense-in-depth cleanup in &lt;step-5.2&gt; above.

      Pre-existing, not yours to fix:
      - Same set as PR9.
    </known-risks>

    <next>
      Step 5 sub-PRs still to ship (architecture-brief §3 + §11):
      - (b) **PR11 — Provider auto-detect from app/layout.tsx**.
        Largest Step 5 sub-PR; worker scans `app/layout.tsx` for
        known providers (next-themes, @tanstack/react-query,
        next-intl, @emotion/react, etc.), emits a
        `providers.auto.tsx` in the bundle, iframe runtime wraps
        every component. Recommended PR11 scope per the chain.
      - (c) `canvas.providers.tsx` fallback — pairs with (b);
        single repo-root file the worker copies into the bundle
        when the customer's provider is bespoke.
      - (d) `Component.canvas.tsx` per-component override —
        exported `controls` merge into / override the auto-
        generated panel.
      - (f) RSC sidebar disposition — promote PR7's `maybe-rsc` /
        `unsupported` inline tile to a sidebar greyed-out leaf
        with explicit "Server component — not supported" note
        (architecture-brief §3 disposition 1).

      Step 5 polish (deferrable past PR11):
      - Multi-replica reconciler jitter (PR10-introduced known-risk).
      - 404-persistent-branch instance deactivation (PR10-
        introduced known-risk).
      - Reconciler env tunables in apps/api/.env.example
        documentation (PR10-introduced known-risk).
      - Connect-gate refusal logging (PR9-known-risk).
      - Near-miss version hints (PR9-known-risk).
      - Monorepo workspace-aware scan (PR9-known-risk).
      - node_modules cache LRU eviction (PR6-known-risk).
      - Theme inheritance via init payload (PR7-known-risk).
      - Per-component diff-skip via esbuild metafile (PR6-known-
        risk).
      - Bundle export discovery heuristic / `entryExportName` field
        (PR7-known-risk).

      R7/R9 still deferred (Railway + GitHub App URLs + CORS lock
      + custom-domain DNS + cross-origin preview subdomain +
      Realtime first-deploy settle window). With Step 5.2 closed
      the system has cheap insurance against the "missed webhook =
      permanent staleness" failure mode — one more "looks like our
      bug but isn't" surface eliminated.

      Before R7/R9: no PAT was taken this session — no shred /
      deletion required.
    </next>
  </pr>
</migration-log>

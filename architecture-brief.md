# usemount.dev — Architecture Research Brief

The architecture decisions for usemount.dev v1. Pairs with `dashboard-build-plan.md`, which covers the dashboard build order. Where the two conflict, the dashboard plan wins.

## Foundational decisions

- **Build pipeline**: backend builds from source. Customers don't run CI, don't publish packages, don't compile in-browser.
- **MVP audience**: two clients. A 5-person startup; a 7-person team inside a 700-person company with a large codebase and many feature branches.
- **Topology**: cloud SaaS, multi-tenant from day one.
- **Instance model**: a unified dashboard listing connected repos and branches across all the user's workspaces. Each branch is a live mirror of the underlying git state.
- **Workspace**: personal-by-default with conversion to team workspaces.
- **Sync trigger**: webhook auto-sync + visible "Re-sync now" button.
- **Rendering**: every component is fully live, 1-to-1 with the customer's source. Sidebar leaves are clickable rows (no embedded previews); the canvas mounts the live component in an iframe when a leaf is selected. No static images at any layer.

---

## The manifest contract

The repo already encodes the contract every imported component must satisfy. From `apps/web/lib/registry/manifest-types.ts`:

```ts
ComponentManifest = {
  id: string
  render: (props) => ReactNode
  defaultProps: P
  controls: {
    variants?: { prop, options[] }
    sizes?: { prop, options[] }
    forms?: { prop, options[] }
    booleans?: prop[]
    slots?: { prop, label }[]
  }
}
```

The demo Button works because `button.manifest.tsx` declares all of this and `CanvasControlsProvider` reads `controls.*` directly into the variants toggle, size selector, and properties panel. No special wiring per component.

**The build pipeline's entire job** is producing one of these manifests per imported component. If we produce a valid manifest, the canvas already knows what to do. This makes the pipeline scope concrete: TypeScript prop-type introspection (via the **ts-morph checker** — the customer's own tsconfig drives a full type-checker so cross-file / `node_modules` aliases and `forwardRef`/HOC unwrap correctly; `react-docgen-typescript` was the PR4 default but produced ~67% empty-controls panels on real customer repos, so PR6 inverted: checker primary, rdt optional cross-check — see `migration-plan.md`'s `<migration-log>` `<pr id="6">`) → emit a manifest matching this shape → bundle the component for iframe rendering → store the manifest in Postgres and the bundle in Storage.

The demo currently calls `manifest.render(props)` inline in the host bundle. The future iframe pipeline replaces `render` with "post props to the iframe URL stored on the manifest." Same controls schema, different transport.

**The product promise — what "always works" actually means.**

Two distinct things, separated:

- **Every client component renders.** Defaults come from the prop types (TypeScript makes this trivial), the iframe mounts, the canvas shows it. This is the user-facing promise. It's true.
- **Toggle richness scales with type clarity.** Clean union literals → variant toggle. Booleans → switches. Generics → render at default, no T toggle. Deep config objects → render at default, fewer rows. The component still appears, still previews — the properties panel just shows what we could detect.
- **The `Component.canvas.tsx` override file is opt-in enrichment, not survival.** Default behavior is "render the component exactly as the source code defines it." The override file exists only for power users who want to declare extra scenarios beyond the auto-generated baseline (e.g., fixed prop combinations they want as named presets). Typical components never need it. The default path is fully live, fully 1-to-1 with source.

**Failure modes and their honest dispositions** (none are "doesn't work"):

1. **React Server Components**: not supported in v1. RSCs cannot run client-side by design; rendering them statically would violate the live-component-1-to-1 pattern. Build pipeline detects RSC components (`"use server"` directive or absence of `"use client"` in a server context) and skips them with an explicit "Server component — not supported" entry in the sidebar. They show up so the customer knows we saw them; they don't pretend to render. RSCs in design systems are rare anyway — design system primitives are almost always client components.
2. **Components needing a provider** (Theme, QueryClient, i18n): two-tier — auto-detect common providers (covers most cases); fall back to one optional `canvas.providers.tsx` at repo root if the customer has bespoke providers. One file per repo, not per component. Component still runs live — the providers are the same React expects in the customer's app.
3. **Server-only API calls at module top** (`cookies()`, `headers()`, top-level `fetch`): the iframe runtime provides safe defaults for these so module evaluation doesn't crash. The component then runs live as written. If a top-level error escapes, we show a "couldn't initialize" tile with the error inline so the customer can fix it.
4. **Routing hooks** (`useRouter`, `useParams`): the iframe runtime provides the same router context React expects, so the component runs as the source defines. Same context contract React requires in dev.
5. **Network-dependent components**: render live in whatever state they're in when there's no real backend (typically loading or empty). This is identical to how the component behaves on a fresh dev start before data loads. Override file can declare fixed scenarios for power users who want named presets.
6. **Build failures**: customer's repo doesn't compile → preview can't either. Sidebar shows failed components grayed out with the build error inline. Their CI catches the same error.
7. **React peer-dep mismatch**: each iframe bundles the customer's React, not ours. Build-time concern, solvable.
8. **CSS collisions across iframes**: each iframe is its own document, scoped naturally. Non-issue.

**The promise, written for the product page:**

> Connect any modern React + Next.js/Vite + Tailwind + TypeScript repo. We bundle and preview every client component, fully live and 1-to-1 with your source. Hover, animations, state, effects — all real. The properties panel auto-populates from your TypeScript prop types — variants, sizes, booleans, slots. No story files. No required config. If your components universally depend on a provider (theme, query client, etc.), drop one `canvas.providers.tsx` at the repo root once — common providers we auto-detect. Components that fail to build show the error inline so you can fix it. Server components are out of scope for v1.

**Bounded support matrix** (what makes "always works" honest):
- React **19+**
- Next.js **16+** or Vite **5+**
- Tailwind **v4+** (other CSS approaches deferred — CSS modules, vanilla CSS, vanilla-extract, styled-components / emotion are post-v1)
- TypeScript **5+** (JavaScript-only repos out of scope for v1 — without types we can't auto-populate the properties panel)
- Package managers: npm, pnpm, yarn, bun (all supported by detecting the lockfile during connect)
- **Client components only.** React Server Components, server-only routes, and server actions are out of scope for v1.

Anything outside this matrix gets a clear "not yet supported" message at connect time, not a half-broken preview. The matrix is what bounds the "always works" promise to something we can actually deliver.

**Day-1 spike**: run the prop introspection pipeline against this repo's own components and one real client codebase. The output ("auto-detected: variants, sizes, booleans" vs "could not detect: X, Y") tells where to invest in auto-detection vs where the provider file naturally absorbs the gap. The spike informs which auto-detection paths to build first; it doesn't gate the product promise.

---

## 1. Auth

Login is required. Three reasons: (1) repo access requires authenticated GitHub permissions, (2) workspaces and share-link scopes need identity, (3) the build pipeline tracks who triggered what for per-workspace quotas.

**Primary: GitHub OAuth + a real GitHub App.** Two distinct things, both needed.

- *GitHub OAuth* signs the user in. One click, no password.
- *GitHub App* ("usemount.dev") gets per-repo, scoped, fine-grained read access plus push-event webhooks. Installed per repo, not org-wide. Cleaner than asking for a broad OAuth `repo` scope, which enterprise security teams refuse.

**Secondary: Google OAuth** for viewers — PMs, designers, leadership clicking share links. They never connect repos.

**No passwords. No magic links.** Both add maintenance surface (verify-email flows, SMTP deliverability) and don't fit the dev/designer audience.

---

## 2. Backend and data storage

**Supabase** for auth, Postgres, file storage, row-level security, and realtime in one bundle. The alternative — wiring Clerk + Neon + R2 + Pusher + Resend separately — multiplies setup, billing, and maintenance surface for no real win at this scale.

What lives in it:

- **Per user**: id, email, avatar, OAuth provider, GitHub user id (for matching the GitHub App install).
- **Per workspace**: id, name, plan, owner_user_id, billing_seats, created_at. Personal workspaces are workspaces with `kind='personal'` and a single member — same table.
- **Per workspace_member**: user_id, workspace_id, role (owner/admin/member/viewer). Roles can be ignored for v1 logic but the column is cheap to add now.
- **Per repo_connection**: id, workspace_id, github_install_id, github_repo_id, default_branch, config_json (parsed from `mount.config.ts` if present), connected_at.
- **Per instance**: id, workspace_id, repo_connection_id, branch, last_synced_commit_sha, last_synced_at, build_status. One instance row per `(repo, branch)` tuple.
- **Per component_manifest**: id, instance_id, slug, folder_path, title, kind, variants_json, states_json, props_schema_json, artifact_url, source_hash. Source_hash lets you skip rebuilds when nothing changed.
- **Per build_job**: id, instance_id, commit_sha, status, started_at, finished_at, log_url, error.
- **Per share_link**: id, instance_id, token, scope (`workspace`/`signed_in`/`public`), created_by, expires_at, revoked_at.

What does **not** live in Postgres: built artifacts (the JS bundles, CSS, MDX docs). Those go to **Supabase Storage** (or R2 if Supabase Storage gets expensive). Manifests in Postgres reference them by URL.

**Source code**: not stored at rest. See section 3.

**`apps/api` (Hono)**: home for the build worker, the GitHub webhook handler, and any long-running server logic that won't fit Next.js route-handler timeouts. Next.js handles short-lived auth callbacks, workspace queries, share-link resolution. `apps/api` handles webhooks, build queue, and clone/build/upload jobs. Clean split: `apps/web` = everything the user sees; `apps/api` = backend worker; `packages/shared` = the `ComponentManifest` type and other shared types.

**Hosting**: both apps deploy to a single **Railway** project. Railway hosts the Next.js frontend and the long-running Node worker under one bill, one deploy pipeline, one mental model. Vercel is the alternative for the frontend specifically (slightly better Next.js performance, made by the same team) but cannot host the build worker — Vercel functions time out before component builds finish, forcing a second service. Railway alone is simpler. Render and Fly.io are equivalent alternatives.

---

## 3. Component import and repo sync — the core hard problem

This is the section the whole product hinges on. Walking through every seed.

### Source storage policy

**Ephemeral build.** Worker pulls source via the GitHub App installation token into a tmpfs sandbox, runs esbuild, writes artifacts + manifests to Supabase Storage and Postgres, then the sandbox is destroyed. Source disappears. Re-sync re-clones — cheap (seconds) for incremental fetches once the worker has a warm clone cached on disk for that repo.

This gives the strongest "we don't host your code" posture for enterprise clients without giving up the SaaS model. If rebuilds become slow at scale, persist source encrypted at rest with per-workspace keys. Don't carry that complexity until it's needed.

### Build mechanism

GitHub App webhook on `push` → webhook handler enqueues a build job → worker:

1. Resolves install token → shallow-clones the repo at the pushed commit.
2. Detects the components dir and globals.css (see "Boundary" below).
3. Diffs against `last_synced_commit_sha` to find changed component files.
4. Builds only changed components with esbuild (per-component entry points sharing a deps graph).
5. Generates manifests from TypeScript prop introspection (ts-morph checker primary; rdt optional cross-check — see §3 above and PR6 in `<migration-log>`); honors a `Component.canvas.tsx` override file when present.
6. Writes manifests + bundles to Storage + Postgres, updates `last_synced_commit_sha`, fires a Realtime event on the instance channel.

Sidebar leaves and the canvas both render the live component in lazy-mounted iframes — no static images at any layer of the system.

For first-time connect, same flow but every component is "changed."

### Boundary of import

A "components-folder-only" import is a leaky boundary. Real components import from `lib/`, `hooks/`, `utils/`, `contexts/`, internal `types/` — the components folder cannot be isolated from its dependencies.

**Model**: the build mounts the *entire repo on disk*, but the *target list of buildable entry points* is the configured components dir, and the *output styles* are derived from the configured CSS entry. Esbuild resolves whatever the components import naturally. The pipeline ships per-component bundles, not "the whole repo."

**Discovery**: optional `mount.config.ts` at repo root declaring components dir, globals.css path, and any per-component overrides (hidden components, manifest enrichments). If absent, auto-detect: try `src/components`, `components`, `app/components`, `apps/*/components/live` in order; if both fail, the connect flow surfaces a setup screen asking the user to point at the right directory and writes the config back as a PR.

No per-component manifest files required. No `*.stories.tsx`. Manifests are generated, not authored.

### Sync trigger

Webhook auto-sync + manual "Re-sync now" button.

**Clarification on local commits**: local-only commits don't exist outside the developer's machine. Git is push-based. If a designer commits but doesn't push, nothing on a server (GitHub or this app's backend) sees it. The product is documented as "the moment you push, it syncs." There's no daemon and no GitHub Desktop integration.

The "Re-sync now" button covers two cases: (1) the webhook missed (network blip, GitHub flakiness, queue choked), (2) the user pushed elsewhere and the webhook hasn't fired yet. Also serves as reassurance UX — users see a button confirming they can force a sync even when auto-sync is working.

### Where the imported data lives

Per the schema in section 2: artifacts in Storage, metadata in Postgres, scoped to the workspace via Supabase RLS. The two-client deployment is fine on shared infra because RLS isolates rows by workspace — the 700-person enterprise client is a workspace, not a server.

### Stale viewer detection

When a rebuild completes, anyone currently viewing that instance in their browser should know. Each instance page subscribes to a Supabase Realtime channel keyed on `instance_id`. On `last_synced_commit_sha` change, the page shows a non-blocking "New version available — refresh" banner. No real-time component re-rendering or state-merging — just "your view is stale, click to swap."

This handles the design-guy-pushes-team-is-watching scenario without building real-time collab.

---

## 4. First-login and onboarding

Login → empty personal workspace dashboard. Empty dashboards are dead-end patterns. Counter with three concrete affordances on first paint:

1. **Big "Connect GitHub repo" CTA.** Opens the GitHub App install flow, repo picker, branch picker, then a "syncing…" state with build progress, then drops the user on the instance.
2. **"Try with a sample repo."** One-click connect to a public usemount.dev demo repo. Lets users poke around the UX before committing their own codebase. Every prospective user can play in 30 seconds without auth burden, repo-access concerns, or build-error confusion.
3. **"Open a shared instance"** input. For users arriving from a share link they bounced on; paste the URL.

Not on first paint: workspace creation, team invites, billing, settings. None of that exists until the user has a working instance.

For users arriving *via a share link*: bypass the empty dashboard entirely. Sign in, land directly on the shared instance, with a "Save to your workspace" affordance if they want their own copy.

---

## 5. Multi-user teams and real-time sync

No real-time collab in v1. The needed pieces:

- **Auto-sync via webhook**: covered.
- **Stale-detection banner**: covered (Realtime channel per instance).
- **Diff awareness**: when sync completes, the manifest diff is known (`X added, Y changed, Z removed`). The banner can say "3 new components since you opened this." Cheap, useful.
- **"What's new" panel** (optional): a timeline of recent syncs per instance, with the commit message and the affected components. Rides on the build_job + commit data already in Postgres. Low-cost win.

Auto-sync is non-negotiable for the design-guy → PM-review flow. The manual button is a fallback, not the primary path.

---

## 6. Workspace and admin model

Personal-by-default, with conversion to team workspaces.

- **Every user has one personal workspace** (kind=personal), auto-created on signup. Repos they connect personally live there.
- **Team workspaces** are explicitly created. User clicks "New workspace" → names it → invites members by email.
- **Conversion**: from a personal workspace, "Move to team workspace" picker. The repo connection moves; instances follow; share links keep working (URLs encode `instance_id`, not workspace).
- **Roles**: schema has `owner | admin | member | viewer`. v1 logic treats everyone equal except `owner` (only owner can delete the workspace, manage billing, remove members). RBAC granularity expands when a customer requires it.
- **Duplicate detection**: when a user is invited to a team workspace that already has Repo X connected, and the user's personal workspace also has Repo X, prompt: "You already have *acme/components* connected personally. Use the team version going forward? [Archive personal, Keep both]." Soft prompt, default to "Archive personal." Detection keys on `github_install_id + github_repo_id`.
- **No real-time collab**, no presence, no cursors, no shared selection. Every user has their own ephemeral view state (selected component, zoom, pan). Workspace state is the connection set + instances + manifests, not the viewing state.

Team workspaces share the *connection state*: members don't re-connect, don't re-pick branches, don't trigger their own builds. The build is workspace-level; views are user-level.

---

## 7. Instances per branch/project

Two refinements on the dashboard model (full UX scope in `dashboard-build-plan.md`):

1. **Instance = (repo_connection, branch).** Not (repo_connection) alone. A repo with five active branches is five instances. Branches are first-class.
2. **Dashboard is one unified main view.** All connected repos across all the user's workspaces appear in one list. Each repo row expands to reveal pinned branches. Click a branch → instance loads in the existing app shell. No nested "pick a workspace, then see projects" flow.

**Not Figma's data model, not Figma's visual language.** Instances are live mirrors of git branches, not frozen documents — there's no "save" action, no version history separate from git, no fork-an-instance flow. Visual reference points are **Linear** (dense rows, no card grid), **Vercel deployments** (status indicator + primary + secondary metadata + hover actions), and **Cron** (structural grouping). Avoid big colored project tiles, recently-opened carousels, emoji avatars per project, multi-row card grids.

**Branch list**: don't show every branch (real codebases have hundreds). On connect, default-pin `main` plus any branches matching a glob (`feat/*`, `release/*` — configurable). Pin/unpin UI lets users curate. Pinned branches auto-rebuild on push; unpinned branches build on demand only.

---

## 8. Desktop vs. web app

**Web.**

usemount.dev is a viewer that needs server-side builds, share-by-URL, always-current branch state. Every value prop — seamless sync, share with PMs, push-and-watch — assumes a centralized backend. Electron adds download/update flow, code signing, OS-specific bugs, no easy "open this link in browser" for stakeholders, worse onboarding.

The repo is already a Next.js app. "Desktop-only" means designed for desktop browser viewports; mobile is unsupported. The codebase already enforces this (`<body>` is `h-full overflow-hidden`).

If a customer ever demands a desktop binary, wrapping the same Next.js app in Electron later is a week of work, not an architectural pivot.

---

## 9. Storybook comparison

What Storybook got right and usemount.dev keeps:

- The variant/state taxonomy. Component → variants → states → sizes is the right axis.
- Addons concept for viewport, a11y, docs — equivalents already scaffolded in the canvas roadmap (size selector, properties panel, docs overlay).
- Decoupling preview from host (Storybook Manager / Preview iframe split). The repo already commits to this.

What Storybook got wrong and usemount.dev avoids:

- **Story files in the codebase.** `*.stories.tsx` per component is Storybook's single biggest maintenance tax. usemount.dev generates manifests from TypeScript prop introspection (ts-morph checker — see §3). Zero required per-component boilerplate.
- **Build pipeline lives in the customer's repo.** Storybook requires maintaining `.storybook/` config, webpack/Vite plugins, addon config. usemount.dev owns the build. Customer just commits.
- **Static deploys for sharing.** Storybook ships are baked-at-deploy-time HTML; sharing means "the URL of your CI deploy." usemount.dev share links are live and always reflect current branch state.
- **MDX as a first-class story format.** MDX-as-stories conflated docs and demos. MDX stays for docs only; demos come from the manifest.
- **The DSL.** `Meta`, `StoryObj`, decorators, parameters — too much surface. Manifests are JSON. Authoring is invisible. Override is configuration.
- **Slow boot times.** Storybook in a real codebase takes 30s to load. Per-component lazy bundle fetch + manifest resolution targets first paint under 1s.

---

## 10. Personas

**A. Solo designer at the 5-person startup.** Connects the company's monorepo. Two branches active: `main` and whatever they're currently building. Shares preview links to the founder via Slack. Stress points: needs zero-effort branch switching, share link must work for the founder without him reading any docs, sync delay > 30s feels broken.

**B. Whole 5-person product+design+dev team at the same startup.** Team workspace, one repo, everyone connected. Designer pushes `feat/cards`, posts the share link, PM and dev open it, comment in Slack (no in-app comments yet). Stress points: PM sign-in must be one click via Google with no GitHub knowledge required; "is this the latest?" must be visually obvious; team workspace creation must take seconds, not setup-wizard minutes.

**C. 7-person design-system team in the 700-person company.** Massive monorepo. 30+ active feature branches. Components have heavy internal dependencies on shared utilities, contexts, providers. Designers and design engineers push multiple times a day. Reviewers (PMs, leadership) come in via share links. Stress points: build can't choke on a 4GB repo; only changed components rebuild; webhook → live in under 60s for a small change; source must be ephemeral or encrypted (legal will ask); need a "private workspace, no public links" toggle. Also: this team probably won't sign up to a SaaS at `usemount.dev` without procurement, so the marketing site needs a "contact us" path well before they'd self-serve. Architecture-wise, nothing in the system depends on multi-tenancy assumptions — a single-tenant copy can be deployed in a customer-controlled region/account if it becomes a deal-breaker.

**D. Public OSS DS library team showcasing their components.** Wants public anonymous share links + custom branding. Lower priority for MVP, but *don't paint the schema into a corner*: the `share_link.scope = 'public'` field and a workspace-level `allow_public_links` toggle should exist from day one even if the UI is hidden behind a feature flag.

**Stress-tests against earlier sections:**

- Persona C breaks if `/components` is hard-coded → resolved by `mount.config.ts` + auto-detect.
- Persona C breaks if every sync is a full rebuild → resolved by per-component `source_hash` diffing.
- Persona C breaks if 30 branches all auto-build on every commit → resolved by the pinned-branch model.
- Persona B breaks if PM has to install GitHub App or learn what "OAuth scope" means → resolved by Google sign-in for viewers + signed-in-anyone share scope as default.
- Persona A breaks if branch switching means "create a new instance from a wizard" → resolved by inline branch list in the dashboard.
- Persona D breaks if `scope = 'public'` doesn't exist in the schema → resolved by including the field from v1, even with the UI gated.

---

## 11. Open questions worth flagging

Items that will bite the architecture but aren't covered above:

- **CSS beyond Tailwind + globals.css.** Real teams use SCSS modules, CSS-in-JS, vanilla-extract. v1 default: assume Tailwind v4 + globals.css. Document the constraint. A second wave of customers will need broader styling support; the build pipeline is the right place to handle it.
- **Fonts and static assets.** Components reference `/public/fonts`, `/public/images`. Build pipeline must ship `public/` along with the bundles. Cheap fix, easy to forget.
- **Path aliases (`tsconfig.paths`)**. Esbuild needs config to honor `@/components/*` style aliases. Test against the 700-person codebase early — exotic tsconfigs will show up fast.
- **Component dependencies on app shell context** (theme providers, query client, i18n). A component that requires `<ThemeProvider>` higher up will throw when mounted in isolation. Manifest needs an optional "wrapper" that wraps the component before render. v1 ships a single optional wrapper file (`canvas.providers.tsx` at repo root); v2 supports per-component wrappers.
- **TypeScript prop introspection has limits.** The PR6 ts-morph-checker engine resolves most of what `react-docgen-typescript` couldn't — union literals from `node_modules`, `forwardRef`/HOC unwrapping, cross-file alias chains. Residuals that the checker still can't always express cleanly: unconstrained generic components (the `<T>` itself; its non-T props still resolve), branded/opaque types, and customer-side re-exports of huge base types (a `PROP_CAP` of 40 fires there). Plan for a manifest override path (`Component.canvas.tsx` per component) for those.
- **Build runtime cost.** A full build of a real DS can be 30-60s and 1-4 GB RAM. Fine for two clients on Railway. At 100 customers, real money. Track `build_duration` on every job from day one so cost-shape data exists before pricing decisions.
- **Webhook reliability.** GitHub webhooks fail. Build a "stale instance" reconciler — for any active workspace, every N hours, fetch the actual `default_branch` SHA from GitHub and compare to `last_synced_commit_sha`. If diverged, enqueue a build. Cheap insurance.
- **GitHub App installation lifecycle.** Users uninstall the app, repos get archived, repos get renamed. Webhook handlers for `installation_repositories.removed`, `repository.archived`, `repository.renamed` ship in v1, not later. Otherwise dead repo connections accumulate.
- **Comments / annotations.** Not v1. The `instance_id + commit_sha` pair is already a stable anchor for future comments — design the URL scheme to encode commit so a comment can resolve to its anchor commit even after re-sync.
- **Pricing / billing.** Out of scope here, but `workspace.plan` and `workspace.seats` exist from v1 in the schema. Cheap to add now, ugly migration later.
- **Telemetry**: track which components are most-viewed. Append `component_view` events to a Postgres table with cheap retention; expose as a workspace-level "Most-viewed this week" panel later (v2).

---

## Decisions to lock before implementation

In rough priority — earlier ones block later ones.

1. **Hosting**: a single **Railway** project hosting both `apps/web` and `apps/api`. Supabase (auth, Postgres, Storage, Realtime, RLS) for data layer. Provision both before any backend code lands.
2. **GitHub App**: register the "usemount.dev" GitHub App early. Permissions: `contents: read`, `metadata: read`, `pull_requests: read` (for future PR previews). Webhook events: `push`, `installation_repositories`, `repository`. App registration is a 30-minute task that unblocks the rest of the build.
3. **Auth providers**: GitHub OAuth (primary, for repo-connecting users) + Google OAuth (for viewers). No email/password, no magic link.
4. **Source policy**: ephemeral build, no source persisted at rest. Revisit only if rebuild cost forces it.
5. **Build target detection**: `mount.config.ts` optional; auto-detect with sensible fallbacks; the connect flow surfaces a "we couldn't find a components folder, point us at it" screen if both fail.
6. **`apps/api` (Hono)**: build worker, webhook handlers, and long-running jobs. Next.js handles short-lived endpoints (auth callbacks, workspace queries, share-link resolution) via route handlers.
7. **Manifest authoring**: TypeScript prop introspection via the ts-morph checker (PR6 D2 inversion — see §3 + `<migration-log>`); no `*.stories.tsx`; optional MDX docs colocated; per-component override file (`Component.canvas.tsx`) only when introspection isn't enough.
8. **Sync trigger**: webhook auto-sync + visible "Re-sync now" button + every-N-hours reconciler against actual branch HEAD.
9. **Workspace model**: personal-by-default, team workspaces explicit, conversion supported, roles in schema but treated as equal in v1 logic (except `owner`), duplicate-repo soft-prompt on team join.
10. **Instance**: `(repo_connection, branch)` tuple. Branches pinned/unpinned by user. Default-pinned: `main` + glob-matched branches.
11. **Share link default scope**: `signed_in` (any account holder can open). `workspace`-only toggle available. The `public` scope exists in schema for future use; no UI in v1.
12. **Stale viewer UX**: Realtime channel per instance, non-blocking "new version" banner, no real-time collab.
13. **No comments, no presence, no real-time collab in v1.** Schema leaves room (`commit_sha` anchor) for future comments.
14. **What ships with `public/`**: assets, fonts, copied wholesale into the artifact bundle. CSS pipeline assumes Tailwind v4 + globals.css for v1.
15. **Telemetry**: log `build_duration` and `component_view` from day one, even with no UI surfaces yet.

The biggest single risk to flag: **build pipeline against the 700-person codebase**. Spike before committing to the full architecture. Pick one real customer repo, write a 200-line build worker prototype that clones, esbuild-bundles every component, and outputs to a local `dist/`. 5 minutes → the model holds. 45 minutes → the architecture needs incremental builds and a worker farm sooner than v1.

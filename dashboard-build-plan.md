# Dashboard-First Build Plan

The build order, route map, and product surface for the user-facing dashboard. Companion to `architecture-brief.md`. Where the two conflict, this doc wins.

---

## The single most important thing in this whole project

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

The Button works on the canvas because `button.manifest.tsx` declares all of this. The canvas controls (variants toggle, size selector, properties panel) read directly from `controls.*`. No special wiring per component.

**Everything the build pipeline does is in service of this:** for each component imported from a customer's repo, produce one of these manifests. Valid manifest → the canvas renders the live component and the properties panel auto-populates. No manifest → that component doesn't appear.

The pipeline scope is therefore concrete: TypeScript prop-type introspection → emit a manifest matching this shape → bundle the component for iframe rendering → store the manifest in Postgres and the bundle in Storage.

---

## Glossary (plain English)

**CI (Continuous Integration).** A robot that runs scripts every time you push to GitHub. Used to run tests, type-check, build production bundles. Lives somewhere external like GitHub Actions or CircleCI.

**GitHub App.** A separate thing from your personal GitHub account or your repo being on GitHub. It's a piece of software you create on GitHub's developer page that other people *install* on their repos to grant it access. The usemount.dev GitHub App is what lets the backend read a customer's repo without that customer pasting personal access tokens anywhere.

**Webhook.** A URL on the backend that GitHub calls every time something happens (a push, a branch creation, etc.). Provided to GitHub once; from then on GitHub pings the URL whenever there's news. This is how "the design guy pushes and the canvas auto-syncs" works without polling GitHub on a timer.

**OAuth.** A flow where a user clicks "Sign in with GitHub" / "Sign in with Google," gets bounced to that provider, approves, and bounces back signed in. usemount.dev never sees their password. The user's identity is verified by the provider.

**Supabase.** A hosted backend at supabase.com. Provides Postgres database (storage for users, workspaces, manifests), authentication (sign in with GitHub, Google, etc.), file storage (where built JS bundles live), and realtime subscriptions (the mechanism for "new version available" notifications). One service, one bill, one SDK from the frontend. Replaces what would otherwise be 4-5 separate services (Auth0/Clerk + Postgres host + S3 + Pusher + email provider).

**Hono.** A small backend framework — like Express but lighter, modern, TypeScript-first. Already wired into `apps/api`. Used for HTTP endpoints the backend worker exposes (GitHub webhook receiver, internal admin endpoints). Could be swapped for plain Node if HTTP routes weren't needed; not load-bearing.

**Hosting.** The setup runs on **Railway** as a single service. Railway hosts both `apps/web` (Next.js frontend) and `apps/api` (the long-running build worker) under one project, one bill, one deploy pipeline. Push to GitHub → Railway redeploys both apps. Vercel is the alternative for just the frontend (made by the people who make Next.js, slightly better Next.js performance), but it cannot host the build worker because Vercel functions time out before a real component build finishes — using Vercel forces a second service for the worker. Railway alone is simpler. Render and Fly.io are equivalent alternatives to Railway.

**npm / pnpm.** Package managers. They install JavaScript libraries. This repo uses pnpm (`pnpm-workspace.yaml`). Customers use one of npm, pnpm, yarn, bun. The build worker supports all four by detecting the lockfile in the customer's repo.

**Iframe runtime.** A small piece of code that runs inside each preview iframe before the customer's component mounts. It supplies the context React expects — router, default theme, mocked server APIs so module evaluation doesn't crash. The component itself runs live and unmodified; the runtime only fills in the surrounding context that would otherwise be supplied by the customer's app shell.

**Tailwind v4.** The CSS framework this repo uses. v1 of usemount.dev only supports Tailwind-based codebases. Other CSS approaches (CSS modules, styled-components, etc.) are deferred.

---

## What's in this repo today

```
usemount.dev/
├── apps/
│   ├── web/          ← frontend (Next.js 16, fully working with mock data)
│   └── api/          ← backend worker (Hono stub, only /health endpoint exists)
├── packages/
│   └── shared/       ← shared TypeScript types (empty today)
```

- `apps/web` is a real Next.js 16 app. Sidebar, canvas, properties panel, demo Button manifest all work. Sidebar tree is hard-coded mock data in `apps/web/lib/registry/data.ts`.
- `apps/api` is a Hono server. Only endpoint is `/health` returning `{ok: true}`. Everything else (build worker, GitHub webhook handler) lives here when built.
- `packages/shared` will hold types both apps need (`ComponentManifest`, etc.).

The split is firm: `apps/web` = everything users see (login, dashboard, app shell, canvas). `apps/api` = backend worker (webhooks, build queue, clone/build/upload jobs). `packages/shared` = shared types. Both apps deploy to one Railway project.

---

## What an "instance" is

An *instance* is a row in the Postgres `instances` table. It points at: a workspace, a repo connection, and a branch. It records the last commit SHA successfully built, when it was built, and where the resulting bundles live in Supabase Storage.

There is no "instance file." There is no "instance state" beyond "what's the last commit synced and what manifests did the build produce."

When a user opens an instance:

1. Browser asks the backend "give me the manifests and bundles for instance ABC."
2. Backend reads the row, returns a list of manifests (one per component) plus URLs to the JS bundles in Storage.
3. Browser loads the manifests into the existing sidebar registry (replacing the demo data).
4. Click a leaf → the canvas mounts the live component in an iframe, props are sent via postMessage, the variants/sizes/booleans/slots panel renders from the manifest's `controls`.

Nothing fresh-builds when a user opens an instance. The build only runs when:

- A repo is first connected (initial build).
- A push webhook fires and changed components are detected (incremental build).
- A user hits "Re-sync now" (forced rebuild).

**Performance guarantee — instant on revisit.** Manifests and bundle URLs are cached in the browser (HTTP cache for bundles, optionally a small client-side cache for the manifest JSON). The first time a user enters a fresh instance, they wait for the manifest list to load (typically <1s on a built instance). Every subsequent open of an already-visited instance is instant — no network wait. Switching branches inside the same workspace is also instant once the user has visited that branch before in their session.

The only time a user waits is:
- First sync of a brand-new repo connection (real build, can take 1-5 minutes for a full repo).
- After a push that touched components they're about to view (incremental rebuild, typically seconds).

---

## Auth flow split: GitHub vs. Google

**GitHub sign-in** is required for anyone who connects a repo. Connecting requires the GitHub App installed on the repo, which requires a GitHub identity with admin rights. There is no path to "connect a repo with Google."

**Google sign-in** is for viewers. PMs, designers, leadership clicking share links. They never connect repos. They view instances someone else connected.

Resulting flow:

- Sign in with GitHub → can do everything (connect, view, share, manage workspaces).
- Sign in with Google → can join workspaces by invitation, view instances, but clicking "Connect a repo" prompts to also link a GitHub identity. Linking is one click — same OAuth flow as signing in. No password, no separate account.

Schema: one user row per person, with a separate `oauth_identities` table holding zero or more `(provider, provider_user_id)` rows per user.

Login screen: two buttons (GitHub, Google), both go to the same place. The GitHub-only requirement only surfaces when the user first tries to connect a repo.

---

## The dashboard

### One unified main view

After login, the user lands on a single page that shows everything they have access to. No nested "pick a workspace, then see projects" flow. All connected repos — personal and team — appear in one list. Team affiliation is visible inline as a small workspace chip on each repo row, with a popover for member details and quick actions.

The user can:
- See every repo they've connected personally and every repo from every team workspace they're in, in one scrollable list.
- Expand a repo row to reveal its pinned branches.
- Click a branch row to enter that instance (mounts the existing AppShell with that branch's components).
- Click the workspace chip on any row to see who else is in that team, switch the repo's ownership between personal and team, or invite members.
- Hit "+ Connect new repo" at any time. New repos default to the user's personal workspace; the connect flow lets them assign to a team workspace instead.

This collapses what would otherwise be a multi-screen Figma-style flow ("workspace picker → workspace home → project") into one screen with everything visible.

### Routes

```
/login                                  → sign in (GitHub or Google)
/                                       → main dashboard (everything in one view)
/connect                                → connect a new repo flow
/[workspace]/[repo]/[branch]            → opens the AppShell with that instance
```

Same Next.js app. Same auth. One deployment. The `[workspace]/[repo]/[branch]` route is what currently lives at `/` in `apps/web/app/page.tsx` — the existing AppShell, just driven by real data instead of the demo registry.

### Visual language

The dashboard reads as the same product as the existing app shell: pragmatic, dense, type-driven, monochrome. Reference points are Linear's project list, Vercel's deployments dashboard, Cron's schedule view — list-first, dense rows, status indicators, hover-revealed quick actions.

Concrete rules:
- Rows are 48–64px tall, single line, monospace where data is technical (timestamps, SHAs, repo identifiers like `org/repo`).
- No card-based grids, no big tiles, no recently-opened carousels.
- Status indicators (synced / syncing / failed / stale) are small dots or chips, not colored backgrounds.
- Hover reveals secondary actions; default state is calm.
- Avoid emoji avatars per project. Repos identify by `org/repo` text.

### Personal vs team affordance on a row

A repo row shows a small workspace chip on the right side:
- Personal: a quiet dot or "Personal" label.
- Team: workspace name + initial-style avatar (e.g. "Acme · A").

Clicking the team chip opens a popover with member list, member count, and "Manage members" action. No need to leave the dashboard to see who's in the team.

### Branch rows

Under an expanded repo:
- Pinned branches always visible as full rows with last-sync timestamp, status indicator, and "Open" / "Re-sync now" actions on hover.
- An "Other branches…" expander lazy-loads the rest from GitHub on click.
- Pin icon appears on hover; clicking toggles pinned state.
- Pinned branches auto-rebuild on push (via webhook). Unpinned branches build on demand only (when first opened).

### `/[workspace]/[repo]/[branch]` (the AppShell)

The existing AppShell, no structural changes. Add at the top of the sidebar: a small instance breadcrumb showing `Workspace ▸ Repo ▸ Branch` with the branch as a dropdown so users can switch branches without going back to the dashboard.

---

## Build order

Each step ships independently and is testable on its own. AI-assisted, the realistic per-step pace is much faster than solo-from-scratch — a step labeled "small" is hours, "medium" is a day or two, "large" is a few days of focused work. Skip the absolute-time framing; let velocity emerge.

### Step 1 (medium): Mock dashboard, no backend

Pure frontend. All data hard-coded like the current sidebar registry.
- `/login` screen (two buttons, styled, no real OAuth wired yet).
- `/` main dashboard (mocked workspaces, repos, branches, team chips, popovers).
- `/connect` (form that doesn't submit).
- Wire `/[workspace]/[repo]/[branch]` to mount the existing AppShell with the existing demo registry.

End of step 1: a clickable product to show people. No backend touched.

### Step 2 (small): Real auth, Supabase wired

- Sign up Supabase, create the project.
- Install `@supabase/supabase-js` in `apps/web`.
- Wire "Continue with GitHub" / "Continue with Google" via Supabase Auth.
- Replace mocked workspaces with real rows from a `workspaces` table.

End of step 2: real users, real workspaces in Postgres, dashboard reads from Supabase. No GitHub App, no builds yet.

### Step 3 (medium): GitHub App + repo connections

- Register the usemount.dev GitHub App on GitHub's developer page (30-minute task).
- In `apps/api`: install-callback handler, list-installed-repos endpoint, create-repo-connection endpoint.

End of step 3: "Connect repo" flow is real. Connecting writes a `repo_connection` row. Still no builds.

### Step 4 (large): First end-to-end sync

The hard step. In `apps/api`, build a worker that:
- Listens for `push` webhooks.
- Clones the repo via GitHub App installation token.
- Detects the components folder and CSS entry (configurable via `mount.config.ts`, with auto-detect fallback).
- Runs esbuild on each component file → produces JS bundles.
- Auto-generates a `ComponentManifest` for each (TypeScript prop introspection via the **ts-morph checker** — primary engine since PR6; rdt stays as optional cross-check, see PR6 in `migration-plan.md`'s `<migration-log>` for the D2 inversion rationale).
- Uploads manifests + bundles to Supabase Storage.
- Updates the `instance` row.

End of step 4: connect this usemount.dev repo itself, push a change, see it reflected in the dashboard. Self-hosted dogfood.

### Step 5 (medium): Manifest auto-generation polish

Step 4 ships the basic auto-manifest path. Step 5 hardens it: handle externally-typed unions, common discriminated unions, generics rendered at defaults, the `canvas.providers.tsx` provider auto-detection. Document the override file (`Component.canvas.tsx`) for power users.

### Step 6 (small): Multi-user team workspaces

Email invitations. Workspace member list and popover. Conversion of personal → team workspace.

### Step 7 (small): Share links

Token-scoped URLs. Default scope: signed-in-anyone. Stale viewer banner via Supabase Realtime when a sync completes while a viewer has the page open.

### Step 8 (ongoing): Roadmap

Pinned/unpinned branches refinement, "what's-new" feed showing recent syncs and changed components, reconciler that polls GitHub for missed webhooks, telemetry on most-viewed components, etc.

---

## "Every component always works" — what that means

Two distinct things, separated:

**Every client component renders.** Defaults come from the prop types (TypeScript makes this trivial), the iframe mounts, the canvas shows it.

**Toggle richness scales with type clarity.** Clean string-union props → variant tabs. Boolean props → switches. Generics like `<DataTable<T>>` → render at default, no T toggle. Deep config objects → render at default, fewer panel rows. The component still appears, still previews — the properties panel just shows what could be detected.

**The override file (`Component.canvas.tsx`) is opt-in enrichment, not survival.** Default behavior is "render the component exactly as the source code defines it." The override exists only for power users who want to declare extra named scenarios beyond the auto-generated baseline (e.g., fixed prop combinations as presets). Typical components never need it.

### Failure modes and their dispositions

1. **React Server Components.** Not supported in v1. RSCs cannot run client-side; rendering them statically would violate the live-component-1-to-1 pattern this product is built around. The build pipeline detects RSC components and lists them in the sidebar with a "Server component — not supported" note. They show up so the customer knows we saw them; they don't pretend to render. RSCs in design systems are rare anyway — design system primitives are almost always client components.
2. **Components requiring a provider** (`<ThemeProvider>`, `<QueryClientProvider>`, i18n). Two-tier:
   - Auto-detect common providers (theme, react-query). Build pipeline scans `app/layout.tsx` or equivalent; if it sees `ThemeProvider` wrapping `{children}`, that wrapper is auto-applied to every preview.
   - Fall back to one optional `canvas.providers.tsx` at repo root if the customer has bespoke providers. **One file per repo, not per component.**
   - Either way, the component runs live — the iframe just supplies the providers React expects in the customer's actual app.
3. **Server-only API calls at module top** (`cookies()`, `headers()`, top-level `fetch`). The iframe runtime supplies safe defaults so module evaluation doesn't crash; the component then runs live. If a top-level error escapes, the leaf shows "couldn't initialize this component" inline with the error so the customer can fix it.
4. **Routing hooks** (`useRouter`, `useParams`, `usePathname`). The iframe runtime supplies the same router context React expects; the component runs as the source defines.
5. **Network-dependent components** (`<UserCard userId={123}>` that fetches data). Render live in whatever state they're in when there's no real backend (typically loading or empty) — identical to how the component looks on a fresh dev start before data arrives. Override file can declare fixed scenarios for power users who want named presets with mocked data.
6. **Build failures.** If the customer's repo doesn't compile, the preview can't either. Sidebar shows failed components grayed out with the build error inline. Their CI catches the same error.
7. **React peer-dependency mismatch.** Each iframe bundles the customer's React, not the host's. Build-time concern, solvable.
8. **CSS collisions across iframes.** Each iframe is its own document, scoped naturally. Non-issue.

### Bounded support matrix

The "always works" promise holds inside this matrix:

- **React 19+**
- **Next.js 16+** or **Vite 5+**
- **Tailwind v4+** (other CSS approaches deferred)
- **TypeScript 5+** (JavaScript-only repos out of scope — without types, the properties panel can't auto-populate)
- **Package managers**: npm, pnpm, yarn, bun (auto-detected from lockfile)
- **Client components only.** React Server Components, server-only routes, and server actions are out of scope for v1.

Anything outside this matrix gets a clear "not yet supported" screen at the connect step. No half-broken previews. No silent failures. Either the stack is fully supported or the connect flow refuses up front.

### Day-1 spike

Before building auto-detection at scale: run prop introspection against this repo's own components and one real client codebase. The output ("auto-detected: variants, sizes, booleans" vs "could not detect: X, Y") tells which auto-detection paths to build first vs which the provider file naturally absorbs. Result informs build order, not the product promise.

---

## Sidebar previews and canvas — how rendering actually works

The pattern is exactly what the current demo Button proves out:

- **Sidebar leaves are clickable rows** with name + icon. No previews inside the rows themselves. No screenshots, no thumbnails, no tiny iframes per leaf.
- **Click a leaf** → the canvas surface mounts the live component for that selection, with the manifest's controls driving the variants toggle, size selector, and properties panel.
- **The canvas is a smart surface**: it auto-fits to the rendered component's bbox, zooms in further on small components (Button), zooms out on large ones (1400px hero section), supports pan/zoom freely. This is already implemented — `canvas-view-context.tsx`, `stage-content.tsx`, the size-aware fit logic in the existing roadmap.

When the build pipeline ships, the only structural change is: `manifest.render(props)` (current in-host React call) becomes "mount the bundled component in an iframe and post props via `postMessage`." Same controls schema, same canvas, same sidebar. The user-facing pattern stays identical to the current demo.

The product is fully live, end to end, 1-to-1 with the customer's source code. Hover, animations, state, effects, focus, keyboard interactions all real. Static thumbnails / screenshots / pre-rendered images do not exist at any layer of the system.

---

## Costs

For two clients with normal usage, the setup runs free or near-free for the first weeks-to-months on free tiers (Railway $5 credit, Supabase free tier, GitHub App free at any scale). Active development on a large customer codebase eventually pushes past the free tiers — Supabase storage fills with bundles, Railway compute burns through the monthly credit. Realistic floor once two real clients are pushing daily: tens of dollars a month, not hundreds. Track build duration and storage usage from day one so the actual cost shape becomes visible before it becomes a problem.

Pricing the product itself is out of scope for this doc. Schema includes `workspace.plan` and `workspace.seats` from day one so adding billing later isn't a migration.

---

## Decisions still open before code begins

1. ~~**Auto-manifest spike target**: confirm `react-docgen-typescript` (or alternative like `ts-morph`) handles this repo's own `ButtonProps` plus one real client codebase. Spike runs in step 4 prep.~~ **CLOSED in PR6 (D2 inversion):** ts-morph checker is primary. Numeric gate (zero `external-union` / `forwardref-unresolved` / `large-base-type` outside the sanctioned Radix-Slot cap) passes on dogfood + REV-Plugin. See PR6 in `migration-plan.md`'s `<migration-log>`.
2. **Sample repo content**: what lives in the public `usemount.dev/sample-components` repo for the "Try with sample" CTA. Recommend 5–10 well-typed components covering Button, Input, Card, Hero, Modal — variety without bloat.
3. **Initial CSS support scope**: Tailwind v4 + globals.css for v1, confirmed. Customers using CSS modules / styled-components / vanilla-extract are explicitly out of scope.
4. **Branch glob defaults**: auto-pin `main`, `feat/*`, `release/*` on first connect, plus user pinning controls. Confirm or adjust.
5. **Account-linking flow for Google viewers connecting a repo**: prompt to link GitHub identity (recommended) vs. force GitHub-only at the connect step. Link flow recommended.
6. **Dashboard visual direction**: Linear/Vercel-style dense rows confirmed, not Figma tiles.

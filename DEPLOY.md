# usemount.dev — first deploy runbook (Railway test deploy)

Goal: get usemount.dev running on a real public URL (a free Railway
`*.up.railway.app` placeholder) so you can install the GitHub App on your
**REV Plugin** repo, connect it in the dashboard, and watch your components
render. Custom domain (`usemount.dev`) comes later — one setting change, no
rework.

**Be realistic:** this is the biggest single step in the project, and the
backend (build worker, GitHub webhooks) has never run in a hosted container
before. **Expect 2–3 deploy → look → fix → redeploy cycles before it's
stable — that's normal, not a sign anything's broken.** The next agent does
this loop *with* you; this doc is the map.

---

## 🔒 THE ONE RULE: secrets never go in chat

Your real keys (Supabase service-role key, GitHub App private key + secrets)
already live on your machine in two gitignored files:
- `apps/api/.env.local`
- `apps/web/.env.local`

You'll **open those files yourself and copy each value straight into
Railway's "Variables" box** (and into GitHub/Supabase settings where noted).
**Never paste a secret key into the chat with an AI agent.** Public values
(Supabase URL, anon key, app IDs) are fine to share; the secret ones are not.

---

## The pieces (what connects to what)

- **Railway** — hosts two things: the **web** dashboard (Next.js) and the
  **api** (the backend that talks to GitHub + builds your components).
- **Supabase** — already hosted (your data + login). No deploy needed; you'll
  just update two settings after Railway is live.
- **Two separate GitHub apps** (this trips people up — they are NOT the same):
  - **App A — the GitHub *App* "usemount-dev"** → reads your repos + receives
    "you pushed code" webhooks. Already registered.
  - **App B — a GitHub *OAuth App*** → just the "Sign in with GitHub" button on
    the dashboard. Its keys live in Supabase's settings, not Railway's.

---

## Part 1 — Create the Railway project (you)

1. Sign in at railway.app (GitHub login is fine).
2. **New Project → Deploy from GitHub repo →** pick `itsmartyhimself/usemount.dev`.
3. You'll add **two services** in this one project (do them one at a time):
   - Service **api**: root directory = repo root; **Build command** =
     `pnpm build`; **Start command** = `pnpm --filter @usemount/api start`.
   - Service **web**: root directory = repo root; **Build command** =
     `pnpm build`; **Start command** = `pnpm --filter @usemount/web start`.
4. **⚠ CRITICAL — set each service's "Watch Branch" to `staging`, NOT `main`.**
   The project rule is never auto-deploy from `main`. We test from `staging`.
   (In Railway: service → Settings → "Source" / "Watch Paths" → branch =
   `staging`.)

> Why `pnpm build` for both: it builds the shared package first, then the app.
> Railway runs it once per service; that's fine.

---

## Part 2 — Set environment variables (you, copying from your .env.local)

Open `apps/api/.env.local` and `apps/web/.env.local` on your machine. In
Railway, each service has a **Variables** tab — paste the values there.

**api service** (from `apps/api/.env.local`, plus the deploy-only ones):
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` 🔒
- `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` 🔒,
  `GITHUB_APP_WEBHOOK_SECRET` 🔒, `GITHUB_APP_PRIVATE_KEY_BASE64` 🔒
- `NODE_MODULES_CACHE=/tmp/usemount-node-modules-cache`  ← deploy-only; the
  default path isn't writable on Railway (see Troubleshooting).
- Leave `PORT` unset — Railway injects it.
- `WEB_ORIGIN` — leave blank for now; you'll set it in Part 4 once you know the
  web URL.

**web service** (from `apps/web/.env.local`):
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (public, fine)
- `SUPABASE_SERVICE_ROLE_KEY` 🔒
- `NEXT_PUBLIC_API_URL` — leave blank for now; set it in Part 4.

---

## Part 3 — Make the package manager available (you, one-time)

When the api builds one of *your* components, it runs the package manager
**your repo** uses. REV Plugin uses pnpm (check its lockfile: `pnpm-lock.yaml`
= pnpm, `yarn.lock` = yarn, `bun.lockb` = bun). Railway's container has `npm`
but not pnpm/yarn by default. If REV Plugin uses pnpm or yarn, add this to the
**api** service:
- A variable `RAILWAY_RUN_UID=0` is NOT needed; instead set the api service's
  build to enable corepack. Simplest: add a **pre-deploy / build** step
  `corepack enable` (Railway: service → Settings → Build → add to the build
  command, e.g. `corepack enable && pnpm build`).

(If REV Plugin uses plain npm, you can skip this.)

---

## Part 4 — First deploy, grab URLs, wire them back (you + agent)

1. Trigger the deploy (Railway deploys on push to `staging`, or click Deploy).
2. Each service gets a public URL under **Settings → Networking → Generate
   Domain** (e.g. `usemount-api-production.up.railway.app` and
   `usemount-web-production.up.railway.app`).
3. **Confirm the api is alive:** open `https://<api-url>/health` in a browser.
   You should see `{"ok":true}`. If yes, the backend booted. 🎉
4. Now wire the two URLs back as variables and redeploy:
   - **web** service → `NEXT_PUBLIC_API_URL = https://<api-url>` (no trailing
     slash).
   - **api** service → `WEB_ORIGIN = https://<web-url>` (this locks the API to
     only accept the dashboard — security hardening for go-live).

---

## Part 5 — Point the GitHub App + Supabase at the new URLs (you)

**App A — GitHub App "usemount-dev"** (github.com → Settings → Developer
settings → GitHub Apps → usemount-dev):
- **Webhook URL** = `https://<api-url>/github/webhook`
- **Setup URL** (post-install redirect) = `https://<web-url>/connect/callback`
- Webhook secret must match the `GITHUB_APP_WEBHOOK_SECRET` you put in Railway.

**App B — GitHub OAuth App** (sign-in): its Client ID + Secret go in
**Supabase Dashboard → Authentication → Providers → GitHub**. Set the
provider's callback to Supabase's own callback URL (shown right there in that
Supabase screen) — not a Railway URL.

**Supabase auth redirect URLs** (Supabase Dashboard → Authentication → URL
Configuration):
- Site URL = `https://<web-url>`
- Add redirect: `https://<web-url>/auth/callback`

---

## Part 6 — Install the App on REV Plugin + test (you, the payoff)

1. Install **App A** on your **REV Plugin** repo: github.com → the
   usemount-dev App → Install → pick REV Plugin.
2. Open the dashboard at `https://<web-url>`, sign in (that's App B).
3. Connect REV Plugin in the dashboard's connect flow.
4. Either push a commit to REV Plugin, or wait for the reconciler to pick it
   up — the api clones it, builds the components, and they appear in the
   sidebar. Open one and watch it render live.

That's the whole product working end-to-end.

---

## Troubleshooting — the issues that usually hit on the first deploy

- **api crashes on boot, log says "Missing required env vars"** → a variable in
  Part 2 is unset/misspelled. The log names which one.
- **Build of a component fails / worker errors on install** → the package
  manager isn't available (Part 3, `corepack enable`), or the
  `NODE_MODULES_CACHE` path isn't writable (confirm
  `/tmp/usemount-node-modules-cache`).
- **Builds time out or run out of memory** → component builds can need 1–4 GB
  RAM and 30–60s. Bump the api service's resources, or test with a smaller
  repo first.
- **Dashboard loads but "can't reach API" / network errors** → `NEXT_PUBLIC_API_URL`
  on the web service is wrong, or `WEB_ORIGIN` on the api doesn't include the
  web URL. Both must match the real URLs from Part 4.
- **Login fails** → App B (OAuth) keys or the Supabase redirect URLs (Part 5)
  are off. Login is App B; repo connection is App A — don't mix them up.
- **Pushed to REV Plugin but nothing rebuilds** → the GitHub App webhook URL
  (Part 5) is wrong, or the webhook secret doesn't match. GitHub App →
  Advanced → "Recent Deliveries" shows whether webhooks are reaching the api.

---

## Note for the agent running this with the owner

- Code prep landed in PR13 (env-driven CORS via `WEB_ORIGIN`; `.env.example`
  documents `WEB_ORIGIN` + `NODE_MODULES_CACHE`). `/health` already existed.
- The owner is non-technical re: infra — do this as a live loop, one part at a
  time, confirming each before moving on. Don't dump all parts at once.
- R7 was "deploy-unverified" until this runbook is executed. Capture whatever
  breaks on the real first deploy into the migration-log + this file so it's
  fixed for good, not re-discovered.
- Branch discipline still holds: test from `staging`; a `main` deploy (true
  go-live) is a separate owner decision once the staging test is green.

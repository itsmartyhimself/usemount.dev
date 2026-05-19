import { createHmac, timingSafeEqual } from "node:crypto"
import { Hono } from "hono"
import { GITHUB_APP_WEBHOOK_SECRET } from "../env.js"
import { supabaseAdmin } from "../supabase/admin.js"

// GitHub App webhook. Signature verification is mandatory and happens BEFORE
// parsing — without it anyone with the URL can forge events. We hash the raw
// request bytes (not a re-stringified object) and constant-time compare
// against x-hub-signature-256.
//
// Lifecycle events (architecture-brief §11): installation_repositories.removed,
// repository.archived, repository.renamed → mark repo_connections inactive /
// rename. PR4 adds installation.deleted (full account/org uninstall) → the PR3
// known-risk that a whole-account uninstall left every connection active=true
// forever. The push→build_jobs path is Step 4. Unhandled events return 200 so
// GitHub stops retrying.
//
// NOTE: `installation` and `installation_repositories` are GitHub-App lifecycle
// events delivered to EVERY app automatically (PR1 <gotcha>: they are invalid
// in manifest default_events for exactly this reason). So this handler fires in
// production with NO GitHub App config change — there is no "subscribe to
// installation events" R9 item to chase. installation.suspend/unsuspend are a
// softer state (may reactivate) and are intentionally NOT handled in PR4.

export const webhookRoutes = new Hono()

function verifySignature(rawBody: string, signature: string | undefined): boolean {
  if (!signature) return false
  const expected =
    "sha256=" +
    createHmac("sha256", GITHUB_APP_WEBHOOK_SECRET())
      .update(rawBody)
      .digest("hex")
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  // timingSafeEqual throws on length mismatch — guard length first.
  return a.length === b.length && timingSafeEqual(a, b)
}

async function deactivateRepos(
  installId: number | undefined,
  repoIds: number[],
): Promise<void> {
  if (repoIds.length === 0) return
  let q = supabaseAdmin()
    .from("repo_connections")
    .update({ active: false })
    .in("github_repo_id", repoIds)
  if (typeof installId === "number") {
    q = q.eq("github_install_id", installId)
  }
  await q
}

// Full account/org uninstall (`installation` event, action=deleted): GitHub
// sends no repository list, the whole install is gone. Deactivate every
// connection bound to it so dead connections don't linger active=true.
async function deactivateAllForInstall(installId: number): Promise<void> {
  await supabaseAdmin()
    .from("repo_connections")
    .update({ active: false })
    .eq("github_install_id", installId)
}

webhookRoutes.post("/github/webhook", async (c) => {
  const raw = await c.req.text()
  if (!verifySignature(raw, c.req.header("x-hub-signature-256"))) {
    return c.json({ error: "bad signature" }, 401)
  }

  const event = c.req.header("x-github-event")
  let payload: {
    action?: string
    installation?: { id?: number }
    repository?: { id?: number; full_name?: string }
    repositories_removed?: { id: number }[]
  }
  try {
    payload = JSON.parse(raw)
  } catch {
    return c.json({ error: "bad json" }, 400)
  }

  if (
    event === "installation_repositories" &&
    payload.action === "removed"
  ) {
    await deactivateRepos(
      payload.installation?.id,
      (payload.repositories_removed ?? []).map((r) => r.id),
    )
  } else if (event === "repository" && payload.action === "archived") {
    await deactivateRepos(payload.installation?.id, [
      ...(payload.repository?.id ? [payload.repository.id] : []),
    ])
  } else if (
    event === "repository" &&
    payload.action === "renamed" &&
    payload.repository?.id &&
    payload.repository.full_name
  ) {
    await supabaseAdmin()
      .from("repo_connections")
      .update({ org_repo: payload.repository.full_name })
      .eq("github_repo_id", payload.repository.id)
  } else if (
    event === "installation" &&
    payload.action === "deleted" &&
    typeof payload.installation?.id === "number"
  ) {
    await deactivateAllForInstall(payload.installation.id)
  }

  // 200 for handled and unhandled alike — a non-2xx makes GitHub retry.
  return c.json({ ok: true })
})

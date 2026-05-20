// PR5 verification harness — Step 4.1 push-webhook → build_jobs.
//
// Boots the configured Hono app in-process (no HTTP port bound) via the
// `app.request(...)` test method, signs payloads with the real webhook secret
// from .env.local, and provisions/tears down sentinel rows so the assertions
// run against the live hosted Supabase without polluting it.
//
// Run with: pnpm --filter @usemount/api verify:push-webhook
// Exits non-zero on any failed assertion. Cleanup is in a finally block so a
// mid-run failure still removes the sentinel rows.

import { createHmac } from "node:crypto"
import { buildApp } from "../src/app.js"
import { GITHUB_APP_WEBHOOK_SECRET } from "../src/env.js"
import { resetAllBuckets } from "../src/lib/rate-limit.js"
import { supabaseAdmin } from "../src/supabase/admin.js"

// All imports above use lazy accessors (env.ts returns functions; supabaseAdmin
// is a lazy factory) so module load does NOT read env. Load .env.local before
// any of those functions are invoked.
try {
  process.loadEnvFile(".env.local")
} catch {
  // No .env.local — relying on process env (Railway pattern; not used here).
}

// Sentinel values — outside GitHub's plausible id space (12+ digits).
const TEST_INSTALL_ID = 999_999_999_991
const TEST_REPO_ID = 999_999_999_992
const PINNED_BRANCH = "test/pr5-pinned"
const UNPINNED_BRANCH = "test/pr5-unpinned"
const OTHER_INSTALL_ID = 999_999_999_993 // mismatch case
const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const SHA_ZERO = "0000000000000000000000000000000000000000"

interface SetupResult {
  workspaceId: string
  repoConnectionId: string
  pinnedInstanceId: string
  unpinnedInstanceId: string
}

async function setup(): Promise<SetupResult> {
  const sb = supabaseAdmin()
  // Use the owner's existing personal workspace — we only need a workspace_id
  // to satisfy the FK; we don't touch any of its real rows.
  const { data: ws, error: wsErr } = await sb
    .from("workspaces")
    .select("id")
    .eq("kind", "personal")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle()
  if (wsErr || !ws) {
    throw new Error(
      "No personal workspace found in hosted DB — sign in once first.",
    )
  }

  // Sentinel repo_connection. Upsert in case a prior run left it behind.
  const { data: conn, error: connErr } = await sb
    .from("repo_connections")
    .upsert(
      {
        workspace_id: ws.id,
        github_install_id: TEST_INSTALL_ID,
        github_repo_id: TEST_REPO_ID,
        org_repo: "verify/pr5-fixture",
        default_branch: PINNED_BRANCH,
        active: true,
      },
      { onConflict: "github_install_id,github_repo_id" },
    )
    .select("id")
    .single()
  if (connErr || !conn) throw new Error(`setup repo_connection: ${connErr?.message}`)

  // Pinned + unpinned sentinel instances on the same connection.
  const { data: insts, error: instErr } = await sb
    .from("instances")
    .upsert(
      [
        {
          workspace_id: ws.id,
          repo_connection_id: conn.id,
          branch: PINNED_BRANCH,
          pinned: true,
        },
        {
          workspace_id: ws.id,
          repo_connection_id: conn.id,
          branch: UNPINNED_BRANCH,
          pinned: false,
        },
      ],
      { onConflict: "repo_connection_id,branch" },
    )
    .select("id, branch, pinned")
  if (instErr || !insts) throw new Error(`setup instances: ${instErr?.message}`)
  const pinned = insts.find((i) => i.branch === PINNED_BRANCH)
  const unpinned = insts.find((i) => i.branch === UNPINNED_BRANCH)
  if (!pinned || !unpinned) throw new Error("setup instances missing")

  // Belt-and-braces: clean any stale build_jobs for these instances.
  await sb
    .from("build_jobs")
    .delete()
    .in("instance_id", [pinned.id, unpinned.id])

  return {
    workspaceId: ws.id,
    repoConnectionId: conn.id,
    pinnedInstanceId: pinned.id,
    unpinnedInstanceId: unpinned.id,
  }
}

async function teardown(s: SetupResult | null): Promise<void> {
  if (!s) return
  const sb = supabaseAdmin()
  // ON DELETE CASCADE handles the chain: repo_connections → instances →
  // build_jobs. Deleting the connection cleans everything we added.
  await sb.from("repo_connections").delete().eq("id", s.repoConnectionId)
}

function sign(rawBody: string): string {
  return (
    "sha256=" +
    createHmac("sha256", GITHUB_APP_WEBHOOK_SECRET())
      .update(rawBody)
      .digest("hex")
  )
}

async function postWebhook(
  app: ReturnType<typeof buildApp>,
  event: string,
  body: unknown,
  opts: { tamperSig?: boolean; noSig?: boolean } = {},
): Promise<{ status: number; text: string }> {
  const raw = JSON.stringify(body)
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": event,
  }
  if (!opts.noSig) {
    headers["x-hub-signature-256"] = opts.tamperSig ? "sha256=deadbeef" : sign(raw)
  }
  const res = await app.request("/github/webhook", {
    method: "POST",
    headers,
    body: raw,
  })
  return { status: res.status, text: await res.text() }
}

function pushPayload(opts: {
  installId?: number
  repoId?: number
  ref?: string
  after?: string
  deleted?: boolean
}): Record<string, unknown> {
  return {
    ref: opts.ref ?? `refs/heads/${PINNED_BRANCH}`,
    before: SHA_ZERO,
    after: opts.after ?? SHA_A,
    deleted: opts.deleted ?? false,
    installation: { id: opts.installId ?? TEST_INSTALL_ID },
    repository: {
      id: opts.repoId ?? TEST_REPO_ID,
      full_name: "verify/pr5-fixture",
    },
  }
}

async function countJobs(
  instanceId: string,
  commitSha?: string,
): Promise<number> {
  let q = supabaseAdmin()
    .from("build_jobs")
    .select("id", { count: "exact", head: true })
    .eq("instance_id", instanceId)
  if (commitSha) q = q.eq("commit_sha", commitSha)
  const { count, error } = await q
  if (error) throw new Error(`countJobs: ${error.message}`)
  return count ?? 0
}

const failures: string[] = []
function assert(label: string, condition: boolean, detail = ""): void {
  if (!condition) {
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`)
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`)
  } else {
    console.log(`  ✓ ${label}`)
  }
}

async function run(): Promise<void> {
  console.log("[verify-push-webhook] booting in-process app...")
  const app = buildApp()
  let s: SetupResult | null = null

  try {
    s = await setup()
    console.log(
      `[verify-push-webhook] sentinel: conn=${s.repoConnectionId}, pinned=${s.pinnedInstanceId}, unpinned=${s.unpinnedInstanceId}`,
    )

    // Reset rate-limit state so we start each suite clean.
    resetAllBuckets()

    console.log("\n[case 1] bad signature → 401 (regression)")
    {
      const r = await postWebhook(app, "push", pushPayload({}), {
        tamperSig: true,
      })
      assert("status is 401", r.status === 401, `got ${r.status}`)
      const c = await countJobs(s.pinnedInstanceId)
      assert("0 build_jobs (no mutation past auth)", c === 0, `got ${c}`)
    }

    console.log("\n[case 2] no signature → 401 (regression)")
    {
      const r = await postWebhook(app, "push", pushPayload({}), { noSig: true })
      assert("status is 401", r.status === 401, `got ${r.status}`)
    }

    console.log("\n[case 3] tag push (refs/tags/X) → 200, 0 rows")
    {
      const r = await postWebhook(
        app,
        "push",
        pushPayload({ ref: "refs/tags/v1.0.0" }),
      )
      assert("status is 200", r.status === 200)
      const c = await countJobs(s.pinnedInstanceId)
      assert("0 build_jobs", c === 0, `got ${c}`)
    }

    console.log("\n[case 4] branch delete (deleted=true) → 200, 0 rows")
    {
      const r = await postWebhook(
        app,
        "push",
        pushPayload({ deleted: true }),
      )
      assert("status is 200", r.status === 200)
      const c = await countJobs(s.pinnedInstanceId)
      assert("0 build_jobs", c === 0, `got ${c}`)
    }

    console.log("\n[case 5] zero-SHA after → 200, 0 rows")
    {
      const r = await postWebhook(
        app,
        "push",
        pushPayload({ after: SHA_ZERO }),
      )
      assert("status is 200", r.status === 200)
      const c = await countJobs(s.pinnedInstanceId)
      assert("0 build_jobs", c === 0, `got ${c}`)
    }

    console.log("\n[case 6] unknown repo (no active connection) → 200, 0 rows")
    {
      const r = await postWebhook(
        app,
        "push",
        pushPayload({ repoId: 111_111_111_111 }),
      )
      assert("status is 200", r.status === 200)
      const c = await countJobs(s.pinnedInstanceId)
      assert("0 build_jobs", c === 0, `got ${c}`)
    }

    console.log("\n[case 7] mismatched install_id → 200, 0 rows")
    {
      const r = await postWebhook(
        app,
        "push",
        pushPayload({ installId: OTHER_INSTALL_ID }),
      )
      assert("status is 200", r.status === 200)
      const c = await countJobs(s.pinnedInstanceId)
      assert("0 build_jobs", c === 0, `got ${c}`)
    }

    console.log("\n[case 8] unpinned branch → 200, 0 rows on unpinned instance")
    {
      const r = await postWebhook(
        app,
        "push",
        pushPayload({ ref: `refs/heads/${UNPINNED_BRANCH}` }),
      )
      assert("status is 200", r.status === 200)
      const c = await countJobs(s.unpinnedInstanceId)
      assert("0 build_jobs on unpinned instance", c === 0, `got ${c}`)
    }

    console.log("\n[case 9] happy path (pinned, SHA_A) → 200, 1 row")
    {
      const r = await postWebhook(app, "push", pushPayload({ after: SHA_A }))
      assert("status is 200", r.status === 200)
      const c = await countJobs(s.pinnedInstanceId, SHA_A)
      assert("1 build_job for SHA_A", c === 1, `got ${c}`)
    }

    console.log("\n[case 10] duplicate push (same instance, same SHA) → 200, still 1 row")
    {
      const r = await postWebhook(app, "push", pushPayload({ after: SHA_A }))
      assert("status is 200", r.status === 200)
      const c = await countJobs(s.pinnedInstanceId, SHA_A)
      assert("still 1 build_job for SHA_A (deduped)", c === 1, `got ${c}`)
    }

    console.log("\n[case 11] different SHA on same instance → 200, 2 total")
    {
      const r = await postWebhook(app, "push", pushPayload({ after: SHA_B }))
      assert("status is 200", r.status === 200)
      const total = await countJobs(s.pinnedInstanceId)
      assert("2 total build_jobs (SHA_A + SHA_B)", total === 2, `got ${total}`)
    }

    console.log("\n[case 12] rate-limit flood: 18 distinct SHAs in parallel → exactly capacity (10) enqueued")
    {
      // Reset SHA_A + SHA_B + leftover buckets so we start the flood fresh.
      await supabaseAdmin()
        .from("build_jobs")
        .delete()
        .eq("instance_id", s.pinnedInstanceId)
      resetAllBuckets()

      // Promise.all = no wall-clock gap between tryConsume() calls (advisor:
      // sequential awaits let the refill formula leak tokens across DB-round-
      // trip latency on slower machines, making the cap=10 assertion flaky).
      // Bursts are exactly the threat model rate-limit defends against.
      const N = 18
      const reqs = Array.from({ length: N }, (_, i) => {
        const sha = `c${String(i).padStart(2, "0")}${"0".repeat(37)}`
        return postWebhook(app, "push", pushPayload({ after: sha }))
      })
      const results = await Promise.all(reqs)
      results.forEach((r, i) =>
        assert(
          `status 200 for flood #${i + 1}`,
          r.status === 200,
          `got ${r.status}`,
        ),
      )
      const total = await countJobs(s.pinnedInstanceId)
      assert(
        "exactly 10 rows enqueued, 8 rate-limited",
        total === 10,
        `got ${total}`,
      )
    }
  } finally {
    console.log("\n[teardown] removing sentinel rows...")
    try {
      await teardown(s)
      console.log("  ✓ sentinel removed")
    } catch (e) {
      console.error("  ✗ teardown failed:", e)
    }
  }

  console.log("")
  if (failures.length > 0) {
    console.error(`[verify-push-webhook] FAIL — ${failures.length} assertion(s):`)
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log("[verify-push-webhook] PASS — all assertions green.")
}

run().catch((e) => {
  console.error("[verify-push-webhook] crashed:", e)
  process.exit(1)
})

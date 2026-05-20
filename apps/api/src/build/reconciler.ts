// Webhook reconciler (Step 5.2). GitHub push webhooks fail sometimes — a blip,
// a queue choke, a rate-limit window — and a missed delivery would otherwise
// leave a pinned instance permanently stale. The reconciler closes that hole:
// every 2h it diffs each pinned instance's `last_synced_commit_sha` against
// the live HEAD via the GitHub App's installation token, and INSERTs a
// `build_jobs (status='queued')` row on drift. The build worker (PR6) then
// picks it up via the lease RPC just like a webhook-triggered job.
//
// Dedup model (load-bearing):
//   - 0002's partial UNIQUE on (instance_id, commit_sha) WHERE status IN
//     ('queued','running') means we cannot double-enqueue the same SHA while
//     a job for it is still in flight. The reconciler racing the push-webhook
//     (or a peer replica's reconciler in the same window) surfaces here as a
//     23505 unique_violation — silently swallowed; the existing active job
//     will build the same SHA. This is what makes multi-replica safe today.
//
// Failure model:
//   - GitHub 404 on a branch → fetchHead returns null. Branch was deleted or
//     the App lost access. Logged + skipped, NOT counted as an error
//     (retrying every 2h won't change it; instance-row deactivation on
//     persistent 404 is a Step 5 polish call).
//   - Network / 500 / rate-limit → fetchHead throws. Per-instance catch
//     increments errors and continues — one bad repo doesn't poison the tick.
//   - DB error on the instances fetch for one connection → errors++, skip
//     that connection, continue with the rest.
//
// The fetchHead seam is a testability injection: the harness stubs it without
// hitting real GitHub. Production uses the default Octokit-backed impl below.
//
// Architecture-brief §11 + dashboard-build-plan Step 5.2. Mounted from
// src/index.ts on a 2h setInterval alongside the build worker.

import type { Octokit } from "@octokit/rest"
import { getInstallationOctokit } from "../github/auth.js"
import { supabaseAdmin } from "../supabase/admin.js"

export type FetchHead = (
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
) => Promise<string | null>

// Resolve a branch's live HEAD via the App's installation Octokit. Returns
// null for a definitive 404 (branch deleted / install lost access), throws
// for everything else so the caller can per-instance error-counter.
const defaultFetchHead: FetchHead = async (octokit, owner, repo, branch) => {
  try {
    const { data } = await octokit.repos.getBranch({ owner, repo, branch })
    return data.commit.sha
  } catch (e) {
    const status = (e as { status?: number }).status
    if (status === 404) return null
    throw e
  }
}

export interface ReconcilerResult {
  checked: number
  enqueued: number
  errors: number
}

export interface ReconcilerOpts {
  /** Test-only injection point. Production uses Octokit-backed default. */
  fetchHead?: FetchHead
}

export async function runReconciler(
  opts: ReconcilerOpts = {},
): Promise<ReconcilerResult> {
  const fetchHead = opts.fetchHead ?? defaultFetchHead
  const sb = supabaseAdmin()

  const { data: conns, error: connErr } = await sb
    .from("repo_connections")
    .select("id, github_install_id, org_repo")
    .eq("active", true)
  if (connErr) {
    console.error(`[reconciler] fetch repo_connections: ${connErr.message}`)
    return { checked: 0, enqueued: 0, errors: 1 }
  }

  let checked = 0
  let enqueued = 0
  let errors = 0

  for (const conn of conns ?? []) {
    if (!conn.org_repo) continue

    const { data: instances, error: instErr } = await sb
      .from("instances")
      .select("id, branch, last_synced_commit_sha")
      .eq("repo_connection_id", conn.id)
      .eq("pinned", true)
    if (instErr) {
      console.error(
        `[reconciler] fetch instances for ${conn.id}: ${instErr.message}`,
      )
      errors++
      continue
    }
    if (!instances || instances.length === 0) continue

    const [owner, repo] = conn.org_repo.split("/")
    if (!owner || !repo) {
      console.warn(`[reconciler] malformed org_repo ${conn.org_repo} — skipping`)
      errors++
      continue
    }

    // One Octokit per connection (per installation). The auth strategy
    // refreshes the 1h installation token internally; instantiation itself is
    // synchronous and cheap.
    const octokit = getInstallationOctokit(Number(conn.github_install_id))

    for (const inst of instances) {
      checked++
      try {
        const liveSha = await fetchHead(octokit, owner, repo, inst.branch)
        if (liveSha === null) {
          console.warn(
            `[reconciler] no head for ${conn.org_repo}#${inst.branch} (branch deleted or access lost)`,
          )
          continue
        }
        if (liveSha === inst.last_synced_commit_sha) continue

        const { error: insErr } = await sb.from("build_jobs").insert({
          instance_id: inst.id,
          commit_sha: liveSha,
          status: "queued",
        })
        if (insErr) {
          // 23505 = unique_violation against build_jobs_active_dedup_idx
          // (0002). Reconciler-vs-push or peer-replica-vs-self collision —
          // expected, silent skip.
          if ((insErr as { code?: string }).code === "23505") continue
          console.error(
            `[reconciler] insert ${inst.id} ${conn.org_repo}#${inst.branch}: ${insErr.message}`,
          )
          errors++
          continue
        }
        enqueued++
        console.log(
          `[reconciler] enqueued ${conn.org_repo}#${inst.branch} (${liveSha.slice(0, 7)})`,
        )
      } catch (e) {
        console.error(
          `[reconciler] ${conn.org_repo}#${inst.branch}: ${(e as Error).message}`,
        )
        errors++
      }
    }
  }

  console.log(
    `[reconciler] tick: ${checked} checked, ${enqueued} enqueued, ${errors} errors`,
  )
  return { checked, enqueued, errors }
}

// ── Recurring-tick scheduler ─────────────────────────────────────────────────
// Mounted from src/index.ts alongside the build worker. setInterval is the
// simplest v1 scheduler — Railway cron is fancier but adds infra. Per-tick
// duration is bounded by N pinned-branch × Octokit getBranch latency, which at
// v1 scale (single-digit customers × few pinned branches) is sub-second; the
// `running` flag is a defensive guard against a future scale window where a
// tick could outlast the interval.

// 2h interval matches architecture-brief §11. Tunable via env so operators
// can dial it (lower at high-traffic scale, higher at quiet scale) and the
// harness can prove the setTimeout chain at fast intervals.
const TICK_INTERVAL_MS =
  Number(process.env.RECONCILER_INTERVAL_MS) || 2 * 60 * 60 * 1000
const FIRST_TICK_DELAY_MS =
  Number(process.env.RECONCILER_FIRST_DELAY_MS) || 60 * 1000

export interface ReconcilerHandle {
  stop: () => void
  done: Promise<void>
}

export function startReconcilerLoop(): ReconcilerHandle {
  let stopped = false
  let running = false
  let timer: NodeJS.Timeout | null = null
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((r) => {
    resolveDone = r
  })

  const scheduleNext = (delay: number): void => {
    if (stopped) return
    timer = setTimeout(() => {
      void tick()
    }, delay)
  }

  const tick = async (): Promise<void> => {
    if (stopped) return
    if (running) {
      // Defensive: a prior tick is still in flight (shouldn't be possible
      // because scheduleNext only fires once tick() resolves, but harmless).
      scheduleNext(TICK_INTERVAL_MS)
      return
    }
    running = true
    try {
      await runReconciler()
    } catch (e) {
      console.error(`[reconciler] tick failed: ${(e as Error).message}`)
    } finally {
      running = false
      if (stopped) {
        resolveDone()
      } else {
        scheduleNext(TICK_INTERVAL_MS)
      }
    }
  }

  console.log(
    `[reconciler] startup (first tick in ~${Math.round(FIRST_TICK_DELAY_MS / 1000)}s, then every ${Math.round(TICK_INTERVAL_MS / 1000)}s)`,
  )
  scheduleNext(FIRST_TICK_DELAY_MS)

  return {
    stop: () => {
      if (stopped) return
      stopped = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      // If no tick is in flight, resolve done immediately so index.ts's
      // shutdown doesn't await indefinitely.
      if (!running) resolveDone()
    },
    done,
  }
}

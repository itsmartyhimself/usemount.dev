// Step-4.2 build worker — lease loop + per-job pipeline.
//
// Started from src/index.ts alongside serve() (NOT mounted as an HTTP route;
// PR5's buildApp/serve extraction is deliberately HTTP-only). The loop polls
// the lease RPC, processes one job at a time, heartbeats every ~2min, and
// drains cleanly on SIGTERM/SIGINT (Railway redeploy semantics).
//
// Per-job pipeline (advisor #3 + handoff STEP 1 13-step recipe):
//   1. fetch instance + repo_connection (clone parameters)
//   2. install token  → 3. shallow clone at job.commit_sha
//   4. install deps with --ignore-scripts --frozen-lockfile + node_modules cache
//   5. parse mount.config.ts (ts-morph AST literal-only) OR fallback components-dir
//   6. init ts-morph Project ONCE; collect entries
//   7. (if non-first-sync) git diff over-approximation: any non-components-dir
//      change = rebuild all
//   8. per-component: introspect → derive controls → bundle → upload → manifest
//      row. Per-component failure → kind='unsupported', job CONTINUES.
//   9. bundle globals.css once
//  10. UPSERT manifests + DELETE stale slugs
//  11. update instances.last_synced_*
//  12. destroy tmpfs source dir (NOT the persistent node_modules cache)

import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { performance } from "node:perf_hooks"
import path from "node:path"
import { spawn } from "node:child_process"

import { Project } from "ts-morph"
import type { BuildManifest } from "@usemount/shared"

import { getInstallationToken } from "../github/auth.js"
import { supabaseAdmin } from "../supabase/admin.js"

import { bundleComponent, bundleGlobalsCss, bundleProviders } from "./bundle.js"
import { shallowClone } from "./clone.js"
import { resolveComponentPresets } from "./component-presets.js"
import { installDeps } from "./deps.js"
import {
  classifyGap,
  deriveControls,
  introspectComponent,
} from "./introspect.js"
import { completeJob, failJob, heartbeat, leaseNextJob, recordJobWarning } from "./lease.js"
import { syncManifests } from "./manifests.js"
import { parseMountConfig } from "./mount-config.js"
import { PROVIDERS_AUTO_FILENAME, resolveProvidersSource } from "./providers.js"
import { uploadCss, uploadJs } from "./storage.js"
import type { BuildJob, InstanceRow, RepoConnectionRow } from "./types.js"

const POLL_MS = 5000
const HEARTBEAT_MS = 2 * 60 * 1000 // 2 min (10-min reclaim window in 0003)
const NODE_MODULES_CACHE =
  process.env.NODE_MODULES_CACHE ?? "/var/lib/usemount/node-modules-cache"

// `usemount` skips the Step 5.5 sibling override files (`Button.usemount.tsx`)
// so they're never treated as buildable component entries.
const COMPONENT_SKIP =
  /\.(manifest|config|test|spec|stories|usemount|d)\.(tsx?|ts)$|(^|\/)index\.tsx?$/

interface WorkerHandle {
  workerId: string
  stop: () => void
  done: Promise<void>
}

/**
 * Start the worker loop. Returns a handle; index.ts uses `stop()` only in
 * tests — production lets SIGTERM/SIGINT set the shutdown flag and the loop
 * returns naturally so Railway's drain can run.
 */
export function startWorkerLoop(): WorkerHandle {
  const workerId = `${process.env.RAILWAY_REPLICA_ID ?? "local"}-${process.pid}-${Date.now()}`
  let shuttingDown = false
  const setShutdown = (reason: string) => {
    if (shuttingDown) return
    console.log(`[worker:${workerId}] ${reason} — finishing current job, then exiting`)
    shuttingDown = true
  }
  // Signal handlers are owned by src/index.ts (single source of process
  // lifecycle); it calls stop() on SIGTERM/SIGINT and awaits done.

  console.log(`[worker:${workerId}] startup`)
  orphanSweep()

  const done = (async () => {
    while (!shuttingDown) {
      let job: BuildJob | null = null
      try {
        job = await leaseNextJob(workerId)
      } catch (e) {
        console.error(`[worker:${workerId}] lease error: ${(e as Error).message}`)
      }
      if (!job) {
        await sleep(POLL_MS)
        continue
      }
      console.log(
        `[worker:${workerId}] lease ${job.id} (instance=${job.instance_id} sha=${job.commit_sha.slice(0, 7)})`,
      )
      const start = performance.now()
      let hb: NodeJS.Timeout | null = null
      let stolen = false
      try {
        hb = setInterval(() => {
          heartbeat(job!.id, workerId)
            .then((ok) => {
              if (!ok) {
                console.warn(`[worker:${workerId}] lease stolen on ${job!.id} — aborting current job`)
                stolen = true
              }
            })
            .catch((e) => {
              console.error(`[worker:${workerId}] heartbeat error: ${(e as Error).message}`)
            })
        }, HEARTBEAT_MS)
        await processJob(job, workerId, () => stolen)
        if (!stolen) {
          await completeJob(job.id, Math.round(performance.now() - start))
          console.log(
            `[worker:${workerId}] success ${job.id} (${Math.round(performance.now() - start)}ms)`,
          )
        }
      } catch (e) {
        if (stolen) {
          // Don't write status if our lease was stolen — another worker owns it now.
          console.warn(`[worker:${workerId}] aborted ${job.id} (lease stolen)`)
        } else {
          const errMsg = (e as Error).message ?? String(e)
          console.error(`[worker:${workerId}] failed ${job.id}: ${errMsg}`)
          await failJob(
            job.id,
            errMsg,
            Math.round(performance.now() - start),
          ).catch((fe) =>
            console.error(`[worker:${workerId}] failJob also failed: ${(fe as Error).message}`),
          )
        }
      } finally {
        if (hb) clearInterval(hb)
      }
    }
    console.log(`[worker:${workerId}] loop exited`)
  })()

  return { workerId, stop: () => setShutdown("explicit stop"), done }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Sweep /tmp for usemount-build-* dirs that a crashed worker left behind.
 * A new worker's own dirs don't exist yet, so this is safe at startup.
 */
function orphanSweep(): void {
  const tmp = tmpdir()
  let names: string[] = []
  try {
    names = readdirSync(tmp)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith("usemount-build-")) continue
    const full = path.join(tmp, name)
    try {
      const st = statSync(full)
      if (st.isDirectory()) {
        rmSync(full, { recursive: true, force: true })
        console.log(`[worker] orphan sweep removed ${full}`)
      }
    } catch {
      // ignore
    }
  }
}

async function processJob(
  job: BuildJob,
  workerId: string,
  isStolen: () => boolean,
): Promise<void> {
  // Fetch instance + repo_connection for clone parameters.
  const { data: instance, error: instErr } = await supabaseAdmin()
    .from("instances")
    .select("id, repo_connection_id, branch, last_synced_commit_sha")
    .eq("id", job.instance_id)
    .maybeSingle<InstanceRow>()
  if (instErr) throw new Error(`fetch instance: ${instErr.message}`)
  if (!instance) throw new Error(`instance ${job.instance_id} not found`)

  const { data: conn, error: connErr } = await supabaseAdmin()
    .from("repo_connections")
    .select("github_install_id, org_repo")
    .eq("id", instance.repo_connection_id)
    .maybeSingle<RepoConnectionRow>()
  if (connErr) throw new Error(`fetch repo_connection: ${connErr.message}`)
  if (!conn) throw new Error(`repo_connection ${instance.repo_connection_id} not found`)

  const installToken = await getInstallationToken(conn.github_install_id)

  const cloneResult = await shallowClone({
    repoFullName: conn.org_repo,
    commitSha: job.commit_sha,
    installToken,
  })

  try {
    if (isStolen()) return

    const installResult = await installDeps({
      workDir: cloneResult.workDir,
      repoId: conn.github_install_id,
      cacheRoot: NODE_MODULES_CACHE,
    })
    console.log(
      `[worker:${workerId}] install ${installResult.pm}${installResult.cached ? " (cached)" : ""} ${installResult.durationMs}ms`,
    )
    if (isStolen()) return

    const mount = parseMountConfig(cloneResult.workDir)
    if (!mount.resolvedComponentsDir) {
      throw new Error("no_components_dir")
    }
    const tsconfigPath = findTsconfig(cloneResult.workDir)

    // Source-diff over-approximation: any change outside componentsDir =
    // rebuild all (shared deps like lib/utils.ts may have changed). First
    // sync (last_synced=null) = build all. Per-component source_hash is
    // computed below — currently informational; the actual per-component
    // diff-skip is a Step 5 polish since esbuild metafile walking is the
    // precise (and more expensive) approach.
    const buildAll = await shouldRebuildAll(
      cloneResult.workDir,
      instance.last_synced_commit_sha,
      job.commit_sha,
      mount.resolvedComponentsDir,
    )
    if (isStolen()) return

    // Non-fatal build warnings (providers / globals.css bundling) accumulate
    // here and are written ONCE to build_jobs.error before the success update,
    // so a succeeded build still surfaces what degraded (rather than the old
    // console.warn-and-swallow). Prefixed by source so a single column is
    // readable when both fail.
    const buildWarnings: string[] = []

    // Step 5.3 + 5.4 — resolve and bundle the providers layer once per build.
    // canvas.providers.tsx (customer override) wins; otherwise auto-detect from
    // app/layout.tsx. Origin "none" means bare render (PR7 behavior, no
    // regression). Failure here is non-fatal: fall back to bare render, the
    // hint surfaces in the log for customer debugging.
    const providersResult = resolveProvidersSource(cloneResult.workDir)
    if (providersResult.source !== null) {
      const providersPath = path.join(cloneResult.workDir, PROVIDERS_AUTO_FILENAME)
      writeFileSync(providersPath, providersResult.source, "utf8")
      const providersHash = createHash("sha256")
        .update(providersResult.source)
        .digest("hex")
        .slice(0, 16)
      try {
        const providersBytes = await bundleProviders({
          entry: providersPath,
          workDir: cloneResult.workDir,
          tsconfigPath,
        })
        await uploadJs({
          instanceId: instance.id,
          slug: "providers",
          sourceHash: providersHash,
          bytes: providersBytes,
        })
        console.log(
          `[worker:${workerId}] providers bundled (origin=${providersResult.origin}, detected=[${providersResult.detected.join(",")}], hash=${providersHash.slice(0, 7)})`,
        )
        if (providersResult.hints.length > 0) {
          for (const h of providersResult.hints) {
            console.log(`[worker:${workerId}] providers hint: ${h}`)
          }
        }
      } catch (e) {
        const msg = (e as Error).message
        console.warn(
          `[worker:${workerId}] providers bundling failed: ${msg} (continuing with bare render)`,
        )
        buildWarnings.push(`providers: ${msg}`)
      }
    } else {
      console.log(
        `[worker:${workerId}] providers: none (${providersResult.hints.join("; ")})`,
      )
    }
    if (isStolen()) return

    const project = new Project({
      tsConfigFilePath: tsconfigPath,
      skipAddingFilesFromTsConfig: true,
    })

    const entries = collectEntries(mount.resolvedComponentsDir)
    const manifests: BuildManifest[] = []
    for (const entry of entries) {
      if (isStolen()) return
      const rel = path.relative(mount.resolvedComponentsDir, entry)
      const slug = rel.replace(/\.tsx$/, "").replace(/[/\\]/g, "-")
      const src = readFileSync(entry, "utf8")
      const sourceHash = createHash("sha256").update(src).digest("hex").slice(0, 16)
      const folderPath = path.relative(cloneResult.workDir, path.dirname(entry))
      try {
        const checker = introspectComponent(project, entry)
        const { controls, propsSchema } = deriveControls(checker.props)
        const gap = classifyGap(checker, controls, src)
        // Step 5.5 — sibling `<Component>.usemount.tsx` named presets, parsed
        // literal-only (never evaluated). Non-fatal by construction: a broken
        // override yields {} presets + hints, never a failed component.
        const { presets, hints: presetHints } = resolveComponentPresets(entry)
        for (const h of presetHints) {
          console.log(`[worker:${workerId}] presets hint (${slug}): ${h}`)
        }
        const bundle = await bundleComponent({
          entry,
          workDir: cloneResult.workDir,
          tsconfigPath,
        })
        const artifactUrl = await uploadJs({
          instanceId: instance.id,
          slug,
          sourceHash,
          bytes: bundle.jsBytes,
        })
        if (bundle.cssBytes) {
          await uploadCss({
            instanceId: instance.id,
            slug,
            sourceHash,
            bytes: bundle.cssBytes,
          })
        }
        manifests.push({
          slug,
          folderPath,
          title: slug,
          kind: "component",
          controls,
          propsSchema,
          states: presets,
          artifactUrl,
          sourceHash,
          introspectionGap: gap,
        })
      } catch (e) {
        // Per-component failure ≠ job failure (handoff STEP 1 #12).
        console.warn(
          `[worker:${workerId}] component ${slug} failed: ${(e as Error).message}`,
        )
        manifests.push({
          slug,
          folderPath,
          title: slug,
          kind: "unsupported",
          controls: {
            booleans: [],
            slots: [],
            strings: [],
            numbers: [],
            handlers: [],
            objects: [],
          },
          propsSchema: {},
          states: {},
          artifactUrl: null,
          sourceHash,
        })
      }
    }
    if (isStolen()) return

    if (mount.resolvedGlobalsCss) {
      const globalSrc = readFileSync(mount.resolvedGlobalsCss, "utf8")
      const globalHash = createHash("sha256")
        .update(globalSrc)
        .digest("hex")
        .slice(0, 16)
      try {
        const bytes = await bundleGlobalsCss({
          globalsCssPath: mount.resolvedGlobalsCss,
          workDir: cloneResult.workDir,
        })
        await uploadCss({
          instanceId: instance.id,
          slug: "globals",
          sourceHash: globalHash,
          bytes,
        })
      } catch (e) {
        const msg = (e as Error).message
        console.warn(
          `[worker:${workerId}] globals.css bundling failed: ${msg} (continuing)`,
        )
        buildWarnings.push(`globals.css: ${msg}`)
      }
    }
    if (isStolen()) return

    // Surface any non-fatal degradations on the (succeeded) job. Non-fatal: a
    // write failure here must not fail an otherwise-good build.
    if (buildWarnings.length > 0) {
      await recordJobWarning(job.id, buildWarnings.join("\n")).catch((e) =>
        console.warn(
          `[worker:${workerId}] recordJobWarning failed: ${(e as Error).message}`,
        ),
      )
    }

    const syncResult = await syncManifests({
      instanceId: instance.id,
      manifests,
    })
    console.log(
      `[worker:${workerId}] manifests upserted=${syncResult.upserted} deleted=${syncResult.deleted}`,
    )

    const { error: updErr } = await supabaseAdmin()
      .from("instances")
      .update({
        last_synced_commit_sha: job.commit_sha,
        last_synced_at: new Date().toISOString(),
        // Matches the build_status enum in 0001 (queued|running|succeeded|
        // failed|canceled) — 'succeeded' is the post-build resting value the
        // sidebar reads for the green dot on a synced instance.
        build_status: "succeeded",
      })
      .eq("id", instance.id)
    if (updErr) throw new Error(`update instance: ${updErr.message}`)

    void buildAll // currently informational; per-component diff-skip is Step 5
  } finally {
    cloneResult.cleanup()
  }
}

async function shouldRebuildAll(
  workDir: string,
  fromSha: string | null,
  toSha: string,
  componentsDir: string,
): Promise<boolean> {
  if (!fromSha) return true // first sync — everything is new
  // We may not have fromSha in our shallow clone (only the toSha commit is
  // fetched). Try the diff; if it fails (missing commit), conservatively
  // rebuild everything.
  return new Promise((resolve) => {
    const p = spawn("git", ["diff", "--name-only", fromSha, toSha], {
      cwd: workDir,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    p.stdout.on("data", (c) => {
      out += c.toString()
    })
    p.on("close", (code) => {
      if (code !== 0) return resolve(true)
      const rel = path.relative(workDir, componentsDir).replaceAll(path.sep, "/")
      const lines = out.split("\n").filter(Boolean)
      const allInComp = lines.every(
        (l) => l === rel || l.startsWith(rel + "/"),
      )
      resolve(!allInComp)
    })
    p.on("error", () => resolve(true))
  })
}

function findTsconfig(workDir: string): string {
  for (const c of ["tsconfig.json", "tsconfig.build.json"]) {
    const p = path.join(workDir, c)
    if (existsSync(p)) return p
  }
  throw new Error("no tsconfig.json")
}

function collectEntries(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue
      out.push(...collectEntries(full))
    } else if (e.name.endsWith(".tsx") && !COMPONENT_SKIP.test(full)) {
      out.push(full)
    }
  }
  return out
}

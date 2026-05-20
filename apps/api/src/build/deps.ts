// Dependency install for the build worker.
//
// THE control against customer postinstall RCE is `--ignore-scripts`. We
// mount untrusted source and feed it to esbuild + the TS checker; running
// the customer's postinstall scripts would let them break out of the worker
// sandbox before we even reach bundling. With --ignore-scripts off, the
// residual is registry-malicious-dep LIBRARY code running at bundle time —
// same risk as any CI; real containment is the 4.3 iframe sandbox.
//
// Cache: node_modules is keyed by (repo_id, sha256(lockfile)) and stored on
// a PERSISTENT volume (NODE_MODULES_CACHE env). Steady-state, only first
// build after a lockfile change actually installs. Eviction is unsolved in
// v1 (carry-forward known-risk — Step 5 owns LRU).

import { spawn } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun"

export interface InstallResult {
  pm: PackageManager
  cached: boolean
  durationMs: number
}

interface LockfileInfo {
  pm: PackageManager
  relPath: string
}

export async function installDeps(opts: {
  workDir: string
  repoId: number
  cacheRoot: string
}): Promise<InstallResult> {
  const start = Date.now()
  const lock = detectLockfile(opts.workDir)
  if (!lock) {
    throw new Error(
      "no lockfile (pnpm-lock.yaml / package-lock.json / yarn.lock / bun.lockb)",
    )
  }
  const lockBytes = readFileSync(path.join(opts.workDir, lock.relPath))
  const lockHash = createHash("sha256").update(lockBytes).digest("hex").slice(0, 16)
  const cacheDir = path.join(opts.cacheRoot, String(opts.repoId), lockHash)
  const cachedNm = path.join(cacheDir, "node_modules")
  const targetNm = path.join(opts.workDir, "node_modules")

  if (existsSync(cachedNm)) {
    cpSync(cachedNm, targetNm, { recursive: true })
    return { pm: lock.pm, cached: true, durationMs: Date.now() - start }
  }

  await runPm(lock.pm, opts.workDir)

  // Best-effort cache persist — install succeeded, a copy failure here is a
  // perf loss next time, not a correctness issue.
  try {
    mkdirSync(cacheDir, { recursive: true })
    cpSync(targetNm, cachedNm, { recursive: true })
  } catch {
    // ignore
  }
  return { pm: lock.pm, cached: false, durationMs: Date.now() - start }
}

function detectLockfile(workDir: string): LockfileInfo | null {
  if (existsSync(path.join(workDir, "pnpm-lock.yaml")))
    return { pm: "pnpm", relPath: "pnpm-lock.yaml" }
  if (existsSync(path.join(workDir, "package-lock.json")))
    return { pm: "npm", relPath: "package-lock.json" }
  if (existsSync(path.join(workDir, "yarn.lock")))
    return { pm: "yarn", relPath: "yarn.lock" }
  if (existsSync(path.join(workDir, "bun.lockb")))
    return { pm: "bun", relPath: "bun.lockb" }
  return null
}

async function runPm(pm: PackageManager, workDir: string): Promise<void> {
  // --frozen-lockfile (or its equivalent) ensures the install matches the
  // committed lockfile exactly; --ignore-scripts blocks customer postinstall.
  const argsByPm: Record<PackageManager, string[]> = {
    pnpm: ["install", "--ignore-scripts", "--frozen-lockfile", "--prefer-offline"],
    npm: ["ci", "--ignore-scripts"],
    yarn: ["install", "--ignore-scripts", "--frozen-lockfile", "--prefer-offline"],
    bun: ["install", "--ignore-scripts", "--frozen-lockfile"],
  }
  await runCmd(pm, argsByPm[pm], workDir)
}

async function runCmd(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    let stderr = ""
    p.stderr.on("data", (c) => {
      stderr += c.toString()
    })
    p.on("close", (code) => {
      if (code === 0) return resolve()
      reject(new Error(`${cmd} exit ${code}: ${stderr.trim().slice(0, 2000)}`))
    })
    p.on("error", reject)
  })
}

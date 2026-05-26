// Shallow-clone a GitHub repo at a specific commit using a fresh install
// token. We use `git` via child_process.spawn rather than `simple-git` (no new
// dep). NOTE: git is NOT on a PaaS runtime image by default — that assumption
// was the trap (every build silently failed `spawn git ENOENT`). Railway's
// builder is Railpack (it migrated off Nixpacks — the old NIXPACKS_PKGS=git env
// var silently stopped working; migration-log PR21). git is provisioned by the
// committed repo-root railpack.json (deploy.aptPackages=["git"]) plus a
// redundant RAILPACK_DEPLOY_APT_PACKAGES=git env var on the api service.
//
// Auth: x-access-token user with the installation token as password — works
// in HTTPS clone URLs and rotates as soon as the App refreshes the token.
//
// The clone goes to a fresh tmpdir per job, returned with a cleanup closure.
// The orphan-sweep at worker startup catches any dirs left over from a
// crashed run (worker.ts).

import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

export interface CloneResult {
  workDir: string
  cleanup: () => void
}

export async function shallowClone(opts: {
  repoFullName: string
  commitSha: string
  installToken: string
}): Promise<CloneResult> {
  const workDir = mkdtempSync(path.join(tmpdir(), "usemount-build-"))
  const url = `https://x-access-token:${opts.installToken}@github.com/${opts.repoFullName}.git`
  try {
    // `git init` + `fetch <sha>` is the only reliable pattern for fetching an
    // arbitrary commit (not necessarily on a branch HEAD). GitHub allows
    // single-commit fetch via the smart HTTP protocol; the partial blob
    // filter keeps the working tree minimal until checkout.
    await runGit(["init", "--quiet"], { cwd: workDir, token: opts.installToken })
    await runGit(["remote", "add", "origin", url], { cwd: workDir, token: opts.installToken })
    await runGit(
      ["fetch", "--depth=1", "--no-tags", "--filter=blob:none", "origin", opts.commitSha],
      { cwd: workDir, token: opts.installToken },
    )
    await runGit(["checkout", "--quiet", "FETCH_HEAD"], { cwd: workDir, token: opts.installToken })
    return {
      workDir,
      cleanup: () => {
        try {
          rmSync(workDir, { recursive: true, force: true })
        } catch {
          // best-effort; orphan-sweep handles re-tries at next worker start
        }
      },
    }
  } catch (e) {
    try {
      rmSync(workDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
    throw e
  }
}

async function runGit(
  args: string[],
  opts: { cwd: string; token: string },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("git", args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // Don't let a configured askpass leak credentials — we set the token
      // inline on the URL, no prompting should ever happen.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
    })
    let stderr = ""
    p.stderr.on("data", (c) => {
      stderr += c.toString()
    })
    p.on("close", (code) => {
      if (code === 0) return resolve()
      // Token leaks in git error messages (the URL is occasionally echoed).
      // Scrub before surfacing — error strings end up in build_jobs.error.
      const scrubbed = stderr.replaceAll(opts.token, "<install-token>")
      reject(new Error(`git ${args[0]} exit ${code}: ${scrubbed.trim() || "no stderr"}`))
    })
    p.on("error", (e) => reject(e))
  })
}

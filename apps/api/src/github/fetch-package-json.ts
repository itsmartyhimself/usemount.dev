import type { Octokit } from "@octokit/rest"

// Fetch the connect-gate inputs (root package.json + a recognised lockfile
// name) from a connected repo. The GitHub App's `contents: read` permission
// (granted at install) covers both reads. Metadata-only — no customer code
// executes; this is the same surface the build worker would touch later.
//
// Two failure modes are distinguished by the caller:
//   - Octokit throws → "couldn't verify" (502, transient)
//   - Octokit returns 200 but no package.json → unsupported (422, actionable)

const PACKAGE_JSON_MAX_BYTES = 1_000_000

const KNOWN_LOCKFILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
] as const

export interface RepoMeta {
  packageJson: unknown | null
  lockfileName: string | null
}

// One root listing + (at most) one file fetch. We pull the root listing first
// to learn (a) is package.json present? and (b) which lockfile is in the
// repo. If package.json is absent, skip the second call entirely.
export async function fetchRepoMeta(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
): Promise<RepoMeta> {
  const root = await octokit.repos.getContent({
    owner,
    repo,
    path: "",
    ref,
  })
  if (!Array.isArray(root.data)) {
    return { packageJson: null, lockfileName: null }
  }

  const fileNames = new Set(
    root.data.filter((e) => e.type === "file").map((e) => e.name),
  )

  let lockfileName: string | null = null
  for (const lock of KNOWN_LOCKFILES) {
    if (fileNames.has(lock)) {
      lockfileName = lock
      break
    }
  }

  if (!fileNames.has("package.json")) {
    return { packageJson: null, lockfileName }
  }

  const pkg = await octokit.repos.getContent({
    owner,
    repo,
    path: "package.json",
    ref,
  })
  if (Array.isArray(pkg.data) || pkg.data.type !== "file") {
    return { packageJson: null, lockfileName }
  }
  if (typeof pkg.data.content !== "string") {
    return { packageJson: null, lockfileName }
  }
  // Sanity cap — a customer package.json over 1 MB is pathological; treat
  // as unreadable rather than risk parsing huge JSON synchronously.
  if (pkg.data.size && pkg.data.size > PACKAGE_JSON_MAX_BYTES) {
    return { packageJson: null, lockfileName }
  }

  const decoded = Buffer.from(pkg.data.content, "base64").toString("utf8")
  let packageJson: unknown | null = null
  try {
    packageJson = JSON.parse(decoded)
  } catch {
    // Parse failure → leave null; matrix check surfaces as a single
    // "package-json: absent" violation.
  }

  return { packageJson, lockfileName }
}

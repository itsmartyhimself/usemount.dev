import { createSupabaseBrowserClient } from "@/lib/supabase/client"

// Browser → apps/api client. apps/api runs with the service-role key and does
// NOT see the Supabase cookie session, so every call carries the signed-in
// user's access token as a bearer (apps/api verifies it + enforces workspace
// authz in code). Mirrors lib/supabase/env.ts: NEXT_PUBLIC_* must be read via
// *literal* property access or Turbopack won't inline it client-side. Unset →
// local apps/api default (per apps/web/.env.example).
function apiBase(): string {
  return process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000"
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    // Parsed JSON body (when the response sent one). Lets callers branch on
    // structured error payloads — e.g. the connect-gate's 422 carries
    // `{ kind: "unsupported", violations: [...] }` for inline rendering.
    public body?: unknown,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

export async function apiFetch<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const supabase = createSupabaseBrowserClient()
  const {
    data: { session },
  } = await supabase.auth.getSession()
  const token = session?.access_token

  const res = await fetch(`${apiBase()}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  })

  if (!res.ok) {
    const ct = res.headers.get("content-type") ?? ""
    if (ct.includes("application/json")) {
      const body = (await res.json().catch(() => null)) as unknown
      const msg =
        body &&
        typeof body === "object" &&
        "message" in body &&
        typeof (body as { message: unknown }).message === "string"
          ? (body as { message: string }).message
          : res.statusText
      throw new ApiError(res.status, msg, body)
    }
    const msg = await res.text().catch(() => res.statusText)
    throw new ApiError(res.status, msg || res.statusText)
  }
  return (await res.json()) as T
}

// Wire shapes — must match apps/api (install-callback.ts / connections.ts).
export interface InstallRepo {
  key: string
  installationId: number
  githubRepoId: number
  orgRepo: string
  defaultBranch: string
  private: boolean
  alreadyConnected: boolean
}

export interface ApiBranch {
  id: string
  name: string
  pinned: boolean
  status: "synced" | "syncing" | "failed" | "stale"
  lastSyncedAt: string | null
}

export const connectApi = {
  installUrl: () => apiFetch<{ url: string }>("/github/install-url"),
  installations: () =>
    apiFetch<{ repos: InstallRepo[] }>("/github/installations"),
  installCallback: (installationId: number, state: string) =>
    apiFetch<{ installationId: number; repos: InstallRepo[] }>(
      "/github/install-callback",
      { method: "POST", body: { installationId, state } },
    ),
  createConnection: (body: {
    workspaceId: string
    installationId: number
    githubRepoId: number
    orgRepo: string
    defaultBranch: string
  }) =>
    apiFetch<{ repoConnectionId: string; redirect: string }>(
      "/repo-connections",
      { method: "POST", body },
    ),
  branches: (repoConnectionId: string) =>
    apiFetch<{ defaultBranch: string; branches: ApiBranch[] }>(
      `/repo-connections/${repoConnectionId}/branches`,
    ),
}

// PR19 — the in-app folder/component picker. Wire shapes must match apps/api
// (github/instances.ts).
export interface RepoTreeDir {
  path: string
  componentCount: number
  totalCount: number
}

export interface RepoTreeResponse {
  commitSha: string
  truncated: boolean
  /** The active per-instance scan override, or null when none (uses defaultScan). */
  selectedDirs: string[] | null
  /** Display-only: the dir the build scans with no override (mount.config or fallback). */
  defaultScan: string | null
  dirs: RepoTreeDir[]
}

export const pickerApi = {
  repoTree: (instanceId: string) =>
    apiFetch<RepoTreeResponse>(`/instances/${instanceId}/repo-tree`),
  // dirs=null (or empty) clears the override → back to mount.config/auto-detect.
  // Persists the selection AND enqueues a rebuild; poll instances.build_status
  // (browser Supabase RLS session) for completion.
  setPreviewDirs: (instanceId: string, dirs: string[] | null) =>
    apiFetch<{
      status: "queued" | "deduped"
      previewDirs: string[] | null
      commitSha: string
    }>(`/instances/${instanceId}/preview-dirs`, {
      method: "PATCH",
      body: { dirs },
    }),
}

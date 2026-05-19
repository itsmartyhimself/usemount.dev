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

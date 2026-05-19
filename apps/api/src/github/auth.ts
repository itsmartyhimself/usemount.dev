import { createAppAuth } from "@octokit/auth-app"
import { Octokit } from "@octokit/rest"
import {
  GITHUB_APP_CLIENT_ID,
  GITHUB_APP_CLIENT_SECRET,
  GITHUB_APP_ID,
  GITHUB_APP_PRIVATE_KEY,
} from "../env.js"

// GitHub App auth. The App identifies itself with a short-lived JWT signed by
// its private key; that JWT is exchanged for a per-installation access token
// (1-hour TTL). Octokit's createAppAuth strategy performs and refreshes that
// exchange internally, so we never hand-roll JWT minting and never cache tokens
// ourselves — fresh per request is correct for v1 (advisor-confirmed).
//
// IMPORTANT: this is the GitHub *App* (usemount-dev, repo access). It is NOT
// the GitHub *OAuth App* used for Supabase sign-in. apps/api only ever touches
// the App. See migration-plan.md <correction pr="2"> for the two-app seam.

function appAuthConfig() {
  return {
    appId: Number(GITHUB_APP_ID()),
    privateKey: GITHUB_APP_PRIVATE_KEY(),
    clientId: GITHUB_APP_CLIENT_ID(),
    clientSecret: GITHUB_APP_CLIENT_SECRET(),
  }
}

// App-level client (authed as the App itself, no installation). Used to read
// installation metadata, e.g. apps.getInstallation({ installation_id }).
export function getAppOctokit(): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: appAuthConfig(),
  })
}

// Installation-scoped client. All repo/branch reads go through this — its
// permissions are exactly what the App was granted on the repos the user
// installed it on (contents/metadata/pull_requests:read per PR1).
export function getInstallationOctokit(installationId: number): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: { ...appAuthConfig(), installationId },
  })
}

// Raw installation access token, when a bare token (not an Octokit) is needed.
export async function getInstallationToken(
  installationId: number,
): Promise<string> {
  const auth = createAppAuth(appAuthConfig())
  const { token } = await auth({ type: "installation", installationId })
  return token
}

import { createHmac, timingSafeEqual } from "node:crypto"
import { GITHUB_APP_WEBHOOK_SECRET } from "../env.js"

// CSRF/anti-tamper token for the GitHub App install redirect round-trip.
// /connect mints one bound to the signed-in user; /connect/callback verifies
// it before trusting GitHub's ?installation_id. Without this, an attacker
// could trick a signed-in user into attaching an attacker-controlled
// installation to the victim's workspace.
//
// Keyed off GITHUB_APP_WEBHOOK_SECRET (always present per REQUIRED_ENV,
// server-only, high entropy). HMAC is one-way so this token leaking never
// discloses the webhook secret, and the literal domain-separation prefix makes
// a state signature and a webhook signature non-interchangeable even though
// they share a key. Avoids expanding the required-env contract for a new
// secret the human would have to provision + rotate.
const DOMAIN = "usemount:install-state:v1:"
const MAX_AGE_MS = 10 * 60_000

function b64url(buf: Buffer): string {
  return buf.toString("base64url")
}

function sign(body: string): string {
  return b64url(
    createHmac("sha256", GITHUB_APP_WEBHOOK_SECRET())
      .update(DOMAIN + body)
      .digest(),
  )
}

export function signInstallState(userId: string): string {
  const body = b64url(Buffer.from(JSON.stringify({ u: userId, t: Date.now() })))
  return `${body}.${sign(body)}`
}

// Returns the bound userId, or null on any failure (bad shape, bad signature,
// expired). Callers MUST treat null as "reject the callback".
export function verifyInstallState(token: string | undefined): string | null {
  if (!token) return null
  const dot = token.indexOf(".")
  if (dot <= 0) return null
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)

  const expected = Buffer.from(sign(body))
  const got = Buffer.from(sig)
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
    return null
  }

  try {
    const { u, t } = JSON.parse(Buffer.from(body, "base64url").toString("utf8"))
    if (typeof u !== "string" || typeof t !== "number") return null
    if (Date.now() - t > MAX_AGE_MS || t > Date.now() + 60_000) return null
    return u
  } catch {
    return null
  }
}

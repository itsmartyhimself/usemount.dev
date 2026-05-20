// In-memory token bucket, per (kind, key). v1 single-replica Railway: a per-
// process Map is fine. Buckets reset on restart — accepted as a v1 footgun
// (worst case: an attacker who saturates a bucket waits ~120s for it to refill,
// not a deploy). Multi-replica → swap for Redis/Postgres-backed counter; the
// `tryConsume` shape doesn't change.
//
// The 4.1 push-webhook uses this to bound the amplification surface: HMAC
// proves "from GitHub", not "reasonable volume", and a single connected repo
// can otherwise enqueue arbitrarily-many distinct-SHA builds in a second. Dedup
// is a SEPARATE mechanism (the build_jobs_active_dedup_idx UNIQUE partial
// index) — keep them apart, the failure modes differ (dedup is correctness;
// rate-limit is DoS-bounding cost ceiling).

interface Bucket {
  tokens: number
  lastRefillMs: number
}

const buckets = new Map<string, Bucket>()

export interface RateLimitConfig {
  capacity: number
  refillPerSec: number
}

// Returns true if a token was consumed; false if the bucket was empty.
// Test hook: pass `nowMs` to make refill math deterministic from a harness.
export function tryConsume(
  kind: string,
  key: string | number,
  cfg: RateLimitConfig,
  nowMs: number = Date.now(),
): boolean {
  const id = `${kind}:${key}`
  let b = buckets.get(id)
  if (!b) {
    b = { tokens: cfg.capacity, lastRefillMs: nowMs }
    buckets.set(id, b)
  }
  const elapsedSec = (nowMs - b.lastRefillMs) / 1000
  if (elapsedSec > 0) {
    b.tokens = Math.min(cfg.capacity, b.tokens + elapsedSec * cfg.refillPerSec)
    b.lastRefillMs = nowMs
  }
  if (b.tokens < 1) return false
  b.tokens -= 1
  return true
}

// Test-only: drop every bucket (verification harness uses this between cases).
export function resetAllBuckets(): void {
  buckets.clear()
}

"use client"

interface NavAvatarProps {
  // Prefetched server-side from the Supabase session (see DashboardNav).
  avatarUrl?: string | null
}

export function NavAvatar({ avatarUrl }: NavAvatarProps) {
  if (avatarUrl) {
    return (
      // External OAuth avatar URL; next/image would need per-provider
      // remotePatterns config — out of scope for PR2.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatarUrl}
        alt="Account"
        width={36}
        height={36}
        style={{
          display: "inline-block",
          width: 36,
          height: 36,
          borderRadius: "var(--radius-full)",
          objectFit: "cover",
          flexShrink: 0,
        }}
      />
    )
  }

  return (
    <span
      aria-label="Account"
      style={{
        display: "inline-block",
        width: 36,
        height: 36,
        borderRadius: "var(--radius-full)",
        background: "var(--gradient-dusk)",
        flexShrink: 0,
      }}
    />
  )
}

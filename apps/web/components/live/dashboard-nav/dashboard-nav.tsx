import Link from "next/link"
import { Button } from "@/components/live/button"
import { DarkModeTrigger } from "@/components/live/dark-mode"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { NavAvatar } from "./nav-avatar"
import { NavSearch } from "./nav-search"

export async function DashboardNav() {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const avatarUrl =
    (user?.user_metadata?.avatar_url as string | undefined) ?? null

  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "var(--spacing-12)",
        height: 60,
        paddingBlock: "var(--spacing-4)",
        paddingInline: "var(--spacing-10)",
        background: "var(--color-bg-primary)",
        flexShrink: 0,
      }}
    >
      <Link
        href="/"
        aria-label="Mount home"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "var(--spacing-3)",
          width: 238,
          height: 36,
          color: "var(--color-text-primary)",
          textDecoration: "none",
        }}
      >
        <span
          aria-hidden
          style={{
            display: "inline-block",
            height: 16,
            width: "calc(16px * 103 / 20)",
            backgroundColor: "var(--color-text-primary)",
            WebkitMaskImage: "url(/SVGs/mount-logo-full.svg)",
            maskImage: "url(/SVGs/mount-logo-full.svg)",
            WebkitMaskRepeat: "no-repeat",
            maskRepeat: "no-repeat",
            WebkitMaskPosition: "center",
            maskPosition: "center",
            WebkitMaskSize: "contain",
            maskSize: "contain",
          }}
        />
      </Link>

      <div style={{ display: "flex", justifyContent: "center", flex: 1 }}>
        <NavSearch />
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--spacing-3)",
        }}
      >
        <Button
          variant="pop"
          size="small"
          form="label"
          label="Connect Repo"
          href="/connect"
        />
        <NavAvatar avatarUrl={avatarUrl} />
        <DarkModeTrigger />
      </div>
    </header>
  )
}

"use client"

import { AuthButton } from "@/components/live/auth-button"
import { HeroCard } from "@/components/live/hero-card"
import { createSupabaseBrowserClient } from "@/lib/supabase/client"

export function LoginScreen() {
  const signInWithGithub = () => {
    const supabase = createSupabaseBrowserClient()
    void supabase.auth.signInWithOAuth({
      provider: "github",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    })
  }

  // Google OAuth provider is deferred to a PR2.x follow-up — it needs a Google
  // Cloud OAuth client (separate console setup). Button stays visually
  // unchanged per CONVENTIONS (no disabled restyle).
  const signInWithGoogle = () => {
    window.alert("Google sign-in is coming soon.")
  }

  return (
    <HeroCard
      brand={
        <span
          role="img"
          aria-label="Mount"
          style={{
            display: "block",
            height: 44,
            width: 44,
            backgroundImage: "url(/SVGs/mount-logo-glyph-backdrop.svg)",
            backgroundRepeat: "no-repeat",
            backgroundPosition: "center",
            backgroundSize: "contain",
          }}
        />
      }
      title="Sign in and connect your repo"
      subtitle="Browse, preview and share live components from your GitHub repo."
      legal={
        <>
          By signing in you agree to the Terms of Service and Privacy Policy.
        </>
      }
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--spacing-2)",
          padding: "var(--spacing-2)",
          background: "var(--color-bg-tertiary)",
          borderRadius: "var(--radius-5)",
        }}
      >
        <AuthButton provider="github" onClick={signInWithGithub} />
        <AuthButton provider="google" onClick={signInWithGoogle} />
      </div>
    </HeroCard>
  )
}

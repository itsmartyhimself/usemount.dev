# usemount.dev — Project Conventions

## Component Architecture

Two folders under `apps/web/components/`:

1. **`imports/shadcn/`** — Base components from shadcn/ui and Radix. Never edit these. Never use directly in app code. They provide structure and a11y only.

2. **`live/`** — App components that wrap imports and apply all visual styling via the token system. This is where all application UI lives.

## Styling Rules

- **Tailwind** is for layout and behavior only: `flex`, `grid`, `items-center`, `gap-*`, positioning, display. Zero default Tailwind visual values.
- **All visual design** (color, radius, spacing, typography) uses CSS variables from `globals.css`.
- **Style props** with `var()` for spacing, primitives, and anything not mapped to a Tailwind utility.
- **Typography** via `.type-1` through `.type-13` classes. Never use `text-sm`, `text-lg`, etc.
- Zero stock Tailwind or shadcn visual fingerprints in the final output.

## Token System

- All tokens live in `apps/web/app/globals.css` under `:root`.
- Only semantic tokens are mapped in `@theme inline {}`.
- Primitives exist but never get Tailwind bindings.
- If a token is missing, ask — don't invent.

## SVG Standards

- Static SVG files live in `apps/web/public/SVGs/`.
- Components reference SVGs from `/SVGs/filename.svg`, not as inline React components.
- All SVGs **must** have `viewBox` attributes — no exceptions.
- Color overrides via `.icon-colored` CSS class or `currentColor` inheritance.
- `@carbon/icons-react` is available for programmatic icon use.
- Run `scripts/copy-icons.ts` to extract specific Carbon icons into `public/SVGs/`.

## Scroll Containers

- Any horizontal scroll container must set `overscroll-behavior-x: contain`.
- Without this, sideways trackpad swipes trigger browser back/forward navigation, which hijacks the user's scroll intent.
- Apply via a shared class (`.scroll-container`) or directly on the element. Never leave a horizontal scroller without it.

## Canvas providers (customer-facing)

When a customer connects a repo, the build worker auto-detects common
providers from `app/layout.tsx` (next-themes, `@tanstack/react-query`,
next-intl, framer-motion) and wraps every preview in them with curated
defaults. If a customer's provider config is bespoke — or uses a library
not in the auto-detect list — the customer drops a **`canvas.providers.tsx`**
file at their repo root. When present, this file replaces the auto-detect
entirely for that instance.

**File shape (strict):**

```tsx
// canvas.providers.tsx — at repo root
import type { ReactNode } from "react"
import { ThemeProvider } from "next-themes"
// ...customer imports...

export default function Providers({ children }: { children: ReactNode }): ReactNode {
  return (
    <ThemeProvider attribute="class" defaultTheme="system">
      {/* whatever wrapper tree the customer needs */}
      {children}
    </ThemeProvider>
  )
}
```

Rules:

- **Default export must be a function** named `Providers` (the name is
  cosmetic; only the default export matters). The iframe bootstrap throws
  if the default export isn't a function.
- The function takes `{ children }` and returns the wrapped tree.
- No side effects at module load. Module evaluation runs in every iframe.
- CSS imports inside this file **fail the bundle** (esbuild has no `.css`
  loader on the providers pipeline). When this happens the worker falls back
  to bare-render and logs the failure. Customer styles for the provider tree
  belong in `globals.css`.
- The file is bundled with `react`, `react-dom`, and `react/jsx-runtime`
  externalised — the iframe runtime supplies them.
- Located at `<repo-root>/canvas.providers.tsx` (or `canvas.providers.ts`).
  Not honored from `app/` or `src/`.

## Lazy Loading

This is a core architectural convention, not an afterthought.

- **Viewport-only rendering**: anything not currently visible must not render or load assets.
- Images load thumbnails first, full resolution on viewport entry (Intersection Observer).
- iframes mount only when visible, unmount when scrolled away.
- Feed pagination is cursor-based, not offset-based.
- Backend returns metadata only; full assets are requested on demand.

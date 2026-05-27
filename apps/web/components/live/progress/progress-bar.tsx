"use client"

// Token-styled determinate progress bar. Wraps the imports/ primitive and applies
// all visuals via semantic tokens (recessed track + high-contrast ink/white fill),
// so it reads correctly in light and dark. Layout/behavior via Tailwind; color,
// radius, and height via var() per the token rules.

import { type CSSProperties } from "react"
import { useReducedMotion, type Transition } from "framer-motion"
import {
  Progress,
  ProgressIndicator,
} from "@/components/imports/animate-ui/progress"

const trackStyle: CSSProperties = {
  height: "var(--spacing-2-5)",
  borderRadius: "var(--radius-full)",
  background: "var(--color-bg-tertiary)",
}

const indicatorStyle: CSSProperties = {
  borderRadius: "var(--radius-full)",
  background: "var(--color-primary)",
}

export function ProgressBar({
  value,
  transition,
  className,
}: {
  /** 0–100. Clamped by Radix against max=100. */
  value: number
  /**
   * Override the indicator animation. The picker passes a linear duration to
   * glide the bar across the estimated build time, then a fast spring to snap
   * to 100% on completion. Omitted → the primitive's default spring.
   */
  transition?: Transition
  className?: string
}) {
  // Reduced motion: snap the fill instead of animating it.
  const reduce = useReducedMotion()
  return (
    <Progress
      value={value}
      className={`relative w-full overflow-hidden ${className ?? ""}`}
      style={trackStyle}
    >
      <ProgressIndicator
        className="h-full w-full"
        style={indicatorStyle}
        transition={reduce ? { duration: 0 } : transition}
      />
    </Progress>
  )
}

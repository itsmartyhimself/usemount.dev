"use client"

// Port of animate-ui's Radix Progress primitive (animate-ui.com/docs/components/radix/progress).
// Retargeted to this repo's libs: the unified `radix-ui` package (already a dep)
// and `framer-motion` instead of animate-ui's `radix-ui` split imports + `motion/react`,
// and the strict context is inlined (no `@/lib/get-strict-context` helper).
//
// imports/ convention: structure + a11y + animation only, no token styling — the
// live/ wrapper (live/progress/progress-bar.tsx) applies all visuals via tokens.
// The indicator slides on translateX (compositor-only) so the bar animates cheaply.

import * as React from "react"
import { Progress as ProgressPrimitive } from "radix-ui"
import { motion, type Transition } from "framer-motion"

type ProgressContextType = { value: number }

const ProgressContext = React.createContext<ProgressContextType | null>(null)

function useProgress(): ProgressContextType {
  const ctx = React.useContext(ProgressContext)
  if (!ctx) {
    throw new Error("useProgress must be used within <Progress>")
  }
  return ctx
}

type ProgressProps = React.ComponentProps<typeof ProgressPrimitive.Root>

function Progress(props: ProgressProps) {
  return (
    <ProgressContext.Provider value={{ value: props.value ?? 0 }}>
      <ProgressPrimitive.Root data-slot="progress" {...props} />
    </ProgressContext.Provider>
  )
}

const MotionProgressIndicator = motion.create(ProgressPrimitive.Indicator)

type ProgressIndicatorProps = React.ComponentProps<typeof MotionProgressIndicator>

function ProgressIndicator({
  transition = { type: "spring", stiffness: 100, damping: 30 },
  ...props
}: ProgressIndicatorProps) {
  const { value } = useProgress()

  return (
    <MotionProgressIndicator
      data-slot="progress-indicator"
      animate={{ x: `-${100 - (value || 0)}%` }}
      transition={transition as Transition}
      {...props}
    />
  )
}

export {
  Progress,
  ProgressIndicator,
  useProgress,
  type ProgressProps,
  type ProgressIndicatorProps,
  type ProgressContextType,
}

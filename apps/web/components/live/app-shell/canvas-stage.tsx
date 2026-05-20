"use client"

import { useMemo } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { useSidebarPanelContext } from "@/components/live/sidebar-panel"
import { StageContent } from "./stage-content"
import { useCanvasView } from "./canvas-view-context"

const EASE_OUT_SOFT: [number, number, number, number] = [0.22, 1, 0.36, 1]
const ENTER_DURATION = 0.22
const EXIT_DURATION = 0.18

type CanvasStageProps = {
  selectedId: string | null
}

export function CanvasStage({ selectedId }: CanvasStageProps) {
  const { view, isAnimating, endAnimation } = useCanvasView()
  const { registry } = useSidebarPanelContext()

  const selected = useMemo(() => {
    if (!selectedId) return null
    return (
      registry.leaves.find((leaf) => leaf.id === selectedId) ?? null
    )
  }, [selectedId, registry])

  return (
    <div
      className="absolute"
      style={{
        left: 0,
        top: 0,
        willChange: "transform",
        transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
        transformOrigin: "0 0",
        transition: isAnimating
          ? "transform var(--duration-slow) var(--ease-out-soft)"
          : "none",
      }}
      onTransitionEnd={(event) => {
        if (event.propertyName === "transform") endAnimation()
      }}
    >
      <AnimatePresence initial={false}>
        <motion.div
          key={selected?.id ?? "empty"}
          initial={{ opacity: 0, filter: "blur(2px)" }}
          animate={{
            opacity: 1,
            filter: "blur(0px)",
            transition: {
              opacity: { duration: ENTER_DURATION, ease: EASE_OUT_SOFT },
              filter: { duration: ENTER_DURATION, ease: EASE_OUT_SOFT },
            },
          }}
          exit={{
            opacity: 0,
            filter: "blur(2px)",
            transition: {
              opacity: { duration: EXIT_DURATION, ease: EASE_OUT_SOFT },
              filter: { duration: EXIT_DURATION, ease: EASE_OUT_SOFT },
            },
          }}
        >
          <StageContent selected={selected} />
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

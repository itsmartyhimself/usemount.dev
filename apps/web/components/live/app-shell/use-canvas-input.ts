"use client"

import { useEffect, useRef } from "react"
import { useCanvasView } from "./canvas-view-context"

const KEY_ZOOM_FACTOR = 1.2

export function useCanvasInput() {
  const { viewportRef, panBy, zoomByWheel, zoomByAtCenter, reset, fitToContent } = useCanvasView()
  const spaceDownRef = useRef(false)
  const draggingRef = useRef(false)

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top

      if (e.ctrlKey || e.metaKey) {
        zoomByWheel(e.deltaY, cx, cy)
      } else {
        panBy(-e.deltaX, -e.deltaY)
      }
    }

    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [viewportRef, panBy, zoomByWheel])

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return

    const onPointerDown = (e: PointerEvent) => {
      const isMiddle = e.button === 1
      const isSpaceDrag = spaceDownRef.current && e.button === 0
      if (!isMiddle && !isSpaceDrag) return
      e.preventDefault()
      draggingRef.current = true
      el.setPointerCapture(e.pointerId)
    }
    const onPointerMove = (e: PointerEvent) => {
      if (!draggingRef.current) return
      panBy(e.movementX, e.movementY)
    }
    const onPointerUp = (e: PointerEvent) => {
      if (!draggingRef.current) return
      draggingRef.current = false
      if (el.hasPointerCapture(e.pointerId)) {
        el.releasePointerCapture(e.pointerId)
      }
    }

    el.addEventListener("pointerdown", onPointerDown)
    el.addEventListener("pointermove", onPointerMove)
    el.addEventListener("pointerup", onPointerUp)
    el.addEventListener("pointercancel", onPointerUp)
    return () => {
      el.removeEventListener("pointerdown", onPointerDown)
      el.removeEventListener("pointermove", onPointerMove)
      el.removeEventListener("pointerup", onPointerUp)
      el.removeEventListener("pointercancel", onPointerUp)
    }
  }, [viewportRef, panBy])

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false
      const tag = target.tagName
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target.isContentEditable
      )
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat && !isTypingTarget(e.target)) {
        spaceDownRef.current = true
        const el = viewportRef.current
        if (el) el.style.cursor = "grab"
        return
      }

      if (!(e.metaKey || e.ctrlKey)) return
      if (isTypingTarget(e.target)) return

      if (e.key === "0") {
        e.preventDefault()
        reset()
      } else if (e.key === "1") {
        e.preventDefault()
        fitToContent()
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault()
        zoomByAtCenter(KEY_ZOOM_FACTOR)
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault()
        zoomByAtCenter(1 / KEY_ZOOM_FACTOR)
      }
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceDownRef.current = false
        const el = viewportRef.current
        if (el) el.style.cursor = ""
      }
    }

    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("keyup", onKeyUp)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("keyup", onKeyUp)
    }
  }, [viewportRef, reset, fitToContent, zoomByAtCenter])
}

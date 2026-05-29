"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react"

export type CanvasView = { x: number; y: number; zoom: number }
export type ContentBbox = { width: number; height: number }

export const ZOOM_MIN = 0.5
export const ZOOM_MAX = 2
export const FIT_MARGIN = 0.24
// TODO(ROADMAP: Canvas → size-aware fit margin): replace FIT_MARGIN with a
// function of bbox size so tiny components don't scale to fill the viewport.
const MIN_VISIBLE_RATIO = 0.5

const clampZoom = (z: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z))

// Mac-trackpad pinch (and ctrl/cmd + wheel) arrives as a wheel event with a
// small per-tick deltaY; exp() turns it into a smooth, symmetric zoom factor.
// Single source of truth so the canvas wheel handler and the iframe-forwarded
// wheel path zoom on one curve.
const ZOOM_SPEED = 0.01

type CanvasViewContextValue = {
  view: CanvasView
  isAnimating: boolean
  viewportRef: RefObject<HTMLDivElement | null>
  contentBboxRef: RefObject<ContentBbox | null>
  setContentBbox: (bbox: ContentBbox) => void
  updateContentBboxBounds: (bbox: ContentBbox) => void
  panBy: (dx: number, dy: number) => void
  zoomAt: (clientX: number, clientY: number, nextZoom: number) => void
  zoomByAt: (factor: number, clientX: number, clientY: number) => void
  zoomByWheel: (deltaY: number, clientX: number, clientY: number) => void
  zoomByAtCenter: (factor: number) => void
  reset: () => void
  fitToContent: () => void
  endAnimation: () => void
}

const CanvasViewContext = createContext<CanvasViewContextValue | null>(null)

export function useCanvasView() {
  const ctx = useContext(CanvasViewContext)
  if (!ctx) {
    throw new Error("useCanvasView must be used inside CanvasViewProvider")
  }
  return ctx
}

export function CanvasViewProvider({ children }: { children: ReactNode }) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const contentBboxRef = useRef<ContentBbox | null>(null)
  const initialFitDoneRef = useRef(false)
  const [view, setView] = useState<CanvasView>({ x: 0, y: 0, zoom: 1 })
  const [isAnimating, setIsAnimating] = useState(false)

  const getViewportSize = useCallback((): { width: number; height: number } | null => {
    const el = viewportRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    // Layout-effect reads can fire before the browser has measured the section
    // (Suspense un-suspend, initial mount). A 0x0 rect produces a garbage fit
    // (zoom clamps to min, x/y land at 0,0). Treat unmeasured as "not ready"
    // so callers fall back gracefully and the resize observer re-fits later.
    if (rect.width === 0 || rect.height === 0) return null
    return { width: rect.width, height: rect.height }
  }, [])

  const computeFit = useCallback(
    (bbox: ContentBbox): CanvasView | null => {
      const size = getViewportSize()
      if (!size) return null
      const zoomX = (size.width * (1 - 2 * FIT_MARGIN)) / Math.max(bbox.width, 1)
      const zoomY = (size.height * (1 - 2 * FIT_MARGIN)) / Math.max(bbox.height, 1)
      const zoom = clampZoom(Math.min(zoomX, zoomY))
      return { x: size.width / 2, y: size.height / 2, zoom }
    },
    [getViewportSize],
  )

  const applyPanBounds = useCallback((next: CanvasView): CanvasView => {
    const size = getViewportSize()
    const bbox = contentBboxRef.current
    if (!size || !bbox) return next
    const halfW = (bbox.width * next.zoom) / 2
    const halfH = (bbox.height * next.zoom) / 2
    const keepW = Math.max(halfW * 2 * MIN_VISIBLE_RATIO, 1)
    const keepH = Math.max(halfH * 2 * MIN_VISIBLE_RATIO, 1)
    const xMin = keepW - halfW
    const xMax = size.width - keepW + halfW
    const yMin = keepH - halfH
    const yMax = size.height - keepH + halfH
    return {
      ...next,
      x: Math.max(xMin, Math.min(xMax, next.x)),
      y: Math.max(yMin, Math.min(yMax, next.y)),
    }
  }, [getViewportSize])

  const setContentBbox = useCallback(
    (bbox: ContentBbox) => {
      contentBboxRef.current = bbox
      const fit = computeFit(bbox)
      // Viewport not measurable yet (Suspense un-suspend, initial mount before
      // layout): store the bbox and let the viewport ResizeObserver below run
      // the first fit when the section reports a non-zero size. Do NOT mark
      // initialFitDoneRef so the corrective fit stays a silent snap.
      if (!fit) return
      if (initialFitDoneRef.current) {
        setIsAnimating(true)
      }
      initialFitDoneRef.current = true
      setView(fit)
    },
    [computeFit],
  )

  // Silent variant: only updates the bbox ref so pan-bound math stays correct
  // when the rendered component resizes mid-interaction (prop tweaks). Avoids
  // snapping the user's view back to fit on every prop change.
  const updateContentBboxBounds = useCallback(
    (bbox: ContentBbox) => {
      contentBboxRef.current = bbox
      setView((v) => applyPanBounds(v))
    },
    [applyPanBounds],
  )

  const panBy = useCallback(
    (dx: number, dy: number) => {
      setIsAnimating(false)
      setView((v) => applyPanBounds({ ...v, x: v.x + dx, y: v.y + dy }))
    },
    [applyPanBounds],
  )

  const zoomAt = useCallback(
    (cx: number, cy: number, nextZoom: number) => {
      setIsAnimating(false)
      setView((v) => {
        const z = clampZoom(nextZoom)
        if (z === v.zoom) return v
        const wx = (cx - v.x) / v.zoom
        const wy = (cy - v.y) / v.zoom
        return applyPanBounds({ x: cx - wx * z, y: cy - wy * z, zoom: z })
      })
    },
    [applyPanBounds],
  )

  const zoomByAt = useCallback(
    (factor: number, cx: number, cy: number) => {
      setIsAnimating(false)
      setView((v) => {
        const z = clampZoom(v.zoom * factor)
        if (z === v.zoom) return v
        const wx = (cx - v.x) / v.zoom
        const wy = (cy - v.y) / v.zoom
        return applyPanBounds({ x: cx - wx * z, y: cy - wy * z, zoom: z })
      })
    },
    [applyPanBounds],
  )

  const zoomByWheel = useCallback(
    (deltaY: number, cx: number, cy: number) => {
      zoomByAt(Math.exp(-deltaY * ZOOM_SPEED), cx, cy)
    },
    [zoomByAt],
  )

  const zoomByAtCenter = useCallback(
    (factor: number) => {
      const size = getViewportSize()
      if (!size) return
      setIsAnimating(true)
      setView((v) => {
        const z = clampZoom(v.zoom * factor)
        if (z === v.zoom) return v
        const cx = size.width / 2
        const cy = size.height / 2
        const wx = (cx - v.x) / v.zoom
        const wy = (cy - v.y) / v.zoom
        return applyPanBounds({ x: cx - wx * z, y: cy - wy * z, zoom: z })
      })
    },
    [getViewportSize, applyPanBounds],
  )

  const reset = useCallback(() => {
    const size = getViewportSize()
    if (!size) return
    setIsAnimating(true)
    setView({ x: size.width / 2, y: size.height / 2, zoom: 1 })
  }, [getViewportSize])

  const fitToContent = useCallback(() => {
    const bbox = contentBboxRef.current
    if (!bbox) return
    const fit = computeFit(bbox)
    if (!fit) return
    setIsAnimating(true)
    setView(fit)
  }, [computeFit])

  const endAnimation = useCallback(() => {
    setIsAnimating(false)
  }, [])

  // Drives the silent first fit when the viewport becomes measurable. During
  // initial mount / Suspense un-suspend, StageContent's layout effect can fire
  // setContentBbox before the section has been laid out — getViewportSize
  // returns null and setContentBbox stores the bbox without setting the view.
  // This observer catches the first non-zero size and runs the fit, bypassing
  // setContentBbox so initialFitDoneRef stays false and there's no tween.
  useEffect(() => {
    const el = viewportRef.current
    if (!el || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(() => {
      if (initialFitDoneRef.current) return
      const bbox = contentBboxRef.current
      if (!bbox) return
      const fit = computeFit(bbox)
      if (!fit) return
      initialFitDoneRef.current = true
      setView(fit)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [computeFit])

  const value = useMemo<CanvasViewContextValue>(
    () => ({
      view,
      isAnimating,
      viewportRef,
      contentBboxRef,
      setContentBbox,
      updateContentBboxBounds,
      panBy,
      zoomAt,
      zoomByAt,
      zoomByWheel,
      zoomByAtCenter,
      reset,
      fitToContent,
      endAnimation,
    }),
    [
      view,
      isAnimating,
      setContentBbox,
      updateContentBboxBounds,
      panBy,
      zoomAt,
      zoomByAt,
      zoomByWheel,
      zoomByAtCenter,
      reset,
      fitToContent,
      endAnimation,
    ],
  )

  return <CanvasViewContext.Provider value={value}>{children}</CanvasViewContext.Provider>
}

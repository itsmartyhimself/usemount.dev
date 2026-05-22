"use client"

// PR7 (Step 4.3): manifest-backed leaves now render via the sandboxed
// preview iframe (apps/web/components/live/iframe-mount). The host listens
// for postMessage bbox updates from the iframe and forwards them to the
// canvas-view context — first non-zero bbox = setContentBbox (fit), later
// bboxes = updateContentBboxBounds (silent bounds update, preserves the
// user's manual zoom/pan).
//
// Per architecture-brief §3 dispositions: manifests with kind=maybe-rsc
// render an inline "Server component — not supported" tile. Kind=unsupported
// or null artifact_url renders a "couldn't initialize" tile.

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react"
import type { IframeBbox } from "@usemount/shared"
import type { LeafRecord } from "@/lib/registry/types"
import { useCanvasView } from "./canvas-view-context"
import { useCanvasControls } from "@/components/live/canvas-controls"
import { IframeMount } from "@/components/live/iframe-mount"

type StageContentProps = {
  selected: LeafRecord | null
}

// Mock sizes used for leaves without a manifest. Manifest-backed components
// measure themselves via the iframe's ResizeObserver → postMessage flow.
const MOCK_SIZES: Record<string, { width: number; height: number }> = {
  "cmp-button": { width: 160, height: 48 },
  "cmp-input": { width: 280, height: 48 },
  "cmp-checkbox": { width: 200, height: 24 },
  "cmp-toggle": { width: 72, height: 32 },
  "cmp-select": { width: 280, height: 48 },
  "cmp-slider": { width: 320, height: 32 },
  "cmp-nav-bar": { width: 1200, height: 64 },
  "cmp-breadcrumbs": { width: 480, height: 28 },
  "cmp-pagination": { width: 360, height: 40 },
  "cmp-tabs": { width: 520, height: 48 },
  "cmp-stepper": { width: 640, height: 64 },
  "cmp-toast": { width: 360, height: 72 },
  "cmp-dialog": { width: 480, height: 320 },
  "cmp-banner": { width: 960, height: 56 },
  "cmp-badge": { width: 80, height: 24 },
  "pg-hero": { width: 1440, height: 720 },
  "pg-feature-grid": { width: 1200, height: 680 },
  "pg-testimonials": { width: 1200, height: 520 },
  "pg-pricing": { width: 1200, height: 720 },
  "pg-cta-footer": { width: 1200, height: 320 },
  "pg-stats-row": { width: 1200, height: 140 },
  "pg-activity-feed": { width: 560, height: 720 },
  "pg-usage-chart": { width: 720, height: 360 },
  "pg-project-card": { width: 360, height: 240 },
  "pg-filter-bar": { width: 960, height: 56 },
  "pg-empty-state": { width: 560, height: 320 },
  "pg-notifications": { width: 420, height: 560 },
  "pg-cart-summary": { width: 480, height: 480 },
  "pg-address-form": { width: 560, height: 640 },
  "pg-payment-selector": { width: 560, height: 280 },
  "pg-order-confirmation": { width: 640, height: 400 },
}

const DEFAULT_SIZE = { width: 520, height: 320 }
const EMPTY_SIZE = { width: 520, height: 260 }
const FAILURE_TILE_SIZE = { width: 520, height: 200 }

const centerAnchorStyle: CSSProperties = {
  position: "absolute",
  left: 0,
  top: 0,
  transform: "translate(-50%, -50%)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
}

const mockCardStyle = (
  width: number,
  height: number,
): CSSProperties => ({
  ...centerAnchorStyle,
  width,
  height,
  borderRadius: "var(--radius-4)",
  background: "var(--color-bg-primary)",
  border: "1px solid var(--color-border-primary)",
  boxShadow: "var(--shadow-small)",
})

const failureTileStyle: CSSProperties = {
  ...centerAnchorStyle,
  width: FAILURE_TILE_SIZE.width,
  height: FAILURE_TILE_SIZE.height,
  borderRadius: "var(--radius-4)",
  background: "var(--color-bg-secondary)",
  border: "1px dashed var(--color-border-secondary)",
  flexDirection: "column",
  padding: "var(--spacing-4)",
  gap: "var(--spacing-2)",
}

export function StageContent({ selected }: StageContentProps) {
  const { setContentBbox, updateContentBboxBounds } = useCanvasView()
  const { manifest, props } = useCanvasControls()
  const fittedForIdRef = useRef<string | null>(null)
  // Error the preview iframe reported (module-load failure or render throw).
  // Surfaced on the canvas as a tile instead of being swallowed — the iframe
  // stays 1×1 on failure, so without this the canvas is just silently blank.
  const [iframeError, setIframeError] = useState<string | null>(null)

  const hasManifest = !!manifest
  const renderableManifest =
    manifest && manifest.kind === "component" && manifest.artifactUrl
      ? manifest
      : null

  // Reset the fit-tracking AND any prior error when the selection changes.
  useLayoutEffect(() => {
    fittedForIdRef.current = null
    setIframeError(null)
  }, [renderableManifest?.id])

  // A surfaced iframe error replaces the invisible 1×1 iframe with a readable
  // tile — give the canvas a fixed bbox to fit it (no measure step).
  useLayoutEffect(() => {
    if (renderableManifest && iframeError) setContentBbox(FAILURE_TILE_SIZE)
  }, [renderableManifest, iframeError, setContentBbox])

  // Mock path: deterministic bbox from the table; refit on selection change.
  useLayoutEffect(() => {
    if (hasManifest) return
    const bbox = selected
      ? (MOCK_SIZES[selected.id] ?? DEFAULT_SIZE)
      : EMPTY_SIZE
    setContentBbox(bbox)
  }, [selected, hasManifest, setContentBbox])

  // Failure tile (kind=maybe-rsc / unsupported / missing artifact_url) gets a
  // fixed bbox so the canvas fits the tile without a measure step.
  useLayoutEffect(() => {
    if (!hasManifest) return
    if (renderableManifest) return
    setContentBbox(FAILURE_TILE_SIZE)
  }, [hasManifest, renderableManifest, setContentBbox])

  const onIframeBbox = useCallback(
    (bbox: IframeBbox, _kind: "ready" | "resize") => {
      if (!renderableManifest) return
      if (bbox.width === 0 && bbox.height === 0) return
      const id = renderableManifest.id
      if (fittedForIdRef.current !== id) {
        fittedForIdRef.current = id
        setContentBbox(bbox)
      } else {
        updateContentBboxBounds(bbox)
      }
    },
    [renderableManifest, setContentBbox, updateContentBboxBounds],
  )

  const onIframeError = useCallback((message: string) => {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[iframe error]", message)
    }
    setIframeError(message)
  }, [])

  if (renderableManifest) {
    // The iframe reported an error (module load / render throw). It posted the
    // message then stayed 1×1 (invisible), so show the message on the canvas.
    if (iframeError) {
      return (
        <div style={failureTileStyle}>
          <p
            className="type-5 text-trim"
            style={{ color: "var(--color-text-primary)" }}
          >
            Component failed to render
          </p>
          <p
            className="font-mono type-2"
            style={{
              color: "var(--color-text-tertiary)",
              textAlign: "center",
              overflow: "auto",
              maxHeight: 120,
              maxWidth: "100%",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {iframeError}
          </p>
        </div>
      )
    }
    return (
      <div style={centerAnchorStyle}>
        <IframeMount
          key={renderableManifest.id}
          manifestId={renderableManifest.id}
          instanceId={renderableManifest.instanceId}
          props={props}
          title={renderableManifest.title}
          onBbox={onIframeBbox}
          onError={onIframeError}
        />
      </div>
    )
  }

  if (hasManifest && manifest) {
    // kind=maybe-rsc / unsupported / null artifact_url
    const heading =
      manifest.kind === "maybe-rsc"
        ? "Server component"
        : "Couldn't initialize"
    const detail =
      manifest.kind === "maybe-rsc"
        ? "Server components aren't supported in v1. Add a 'use client' directive at the top of the file to preview."
        : "The build pipeline didn't produce a bundle for this component. Check the build log for details."
    return (
      <div style={failureTileStyle}>
        <p
          className="type-5 text-trim"
          style={{ color: "var(--color-text-primary)" }}
        >
          {heading}
        </p>
        <p
          className="type-3 text-trim"
          style={{ color: "var(--color-text-tertiary)", textAlign: "center" }}
        >
          {detail}
        </p>
      </div>
    )
  }

  if (!selected) {
    return (
      <div style={mockCardStyle(EMPTY_SIZE.width, EMPTY_SIZE.height)}>
        <p
          className="type-4 text-trim"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Select a component to preview
        </p>
      </div>
    )
  }

  const bbox = MOCK_SIZES[selected.id] ?? DEFAULT_SIZE
  return (
    <div style={mockCardStyle(bbox.width, bbox.height)}>
      <div
        className="flex flex-col items-center"
        style={{ gap: "var(--spacing-3)" }}
      >
        <p
          className="type-5 text-trim"
          style={{ color: "var(--color-text-primary)" }}
        >
          {selected.name}
        </p>
        <p
          className="type-3 text-trim"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {selected.id}
        </p>
      </div>
    </div>
  )
}

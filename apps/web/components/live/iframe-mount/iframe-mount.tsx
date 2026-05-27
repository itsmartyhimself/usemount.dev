"use client"

// Iframe wrapper that exchanges typed postMessages with the preview HTML
// served by `apps/web/app/preview/[manifestId]/route.ts`.
//
// Lifecycle:
//   1. Mount: iframe loads at /preview/<manifestId> with sandbox attrs.
//   2. Iframe runtime imports the customer bundle and posts `ready` once.
//   3. Host (this component) responds with `init` carrying the current props.
//   4. Iframe mounts; ResizeObserver posts `resize` with the rendered bbox.
//   5. On prop change, host posts `setProps` (no remount).
//   6. On error/unhandledrejection in the iframe, host receives `error`.
//
// The iframe element is sized from the bbox the iframe reports — `display:
// block`, width/height applied as CSS from the latest `ready`/`resize`. The
// canvas zooms/pans this element as a unit.
//
// Security:
//   - `sandbox="allow-scripts"` ONLY; NO `allow-same-origin` → opaque origin
//     means the iframe can't reach host cookies/storage/DOM.
//   - Source-validate every incoming message: `event.source ===
//     iframe.contentWindow`. The iframe's `event.origin` is the string
//     `"null"` under opaque-origin sandbox, so we DON'T lock by origin.
//   - Never eval/exec anything from the iframe; payloads are typed via
//     `isIframeToHost` and read by field only.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react"
import {
  IFRAME_PROTOCOL_VERSION,
  type HostToIframe,
  type IframeBbox,
  isIframeToHost,
} from "@usemount/shared"
import { createSupabaseBrowserClient } from "@/lib/supabase/client"

export interface IframeMountProps {
  manifestId: string
  /** The instance the manifest belongs to — used for component_views telemetry. */
  instanceId: string
  /** Props sent to the iframe on init + each setProps. Plain JSON only. */
  props: Record<string, unknown>
  /** Optional title for assistive tech + browser tooling. */
  title?: string
  /**
   * Called once on `ready` with the iframe's initial bbox (may be {0,0} if
   * the runtime hasn't rendered yet) AND on every subsequent `resize`. The
   * `kind` flag lets the canvas distinguish "first fit" from "track bounds".
   */
  onBbox?: (bbox: IframeBbox, kind: "ready" | "resize") => void
  /** Called when the iframe reports an error from its bootstrap. */
  onError?: (message: string) => void
}

const INITIAL_W = 1
const INITIAL_H = 1
const MAX_DIMENSION = 8192 // sanity clamp on iframe-reported bbox

// Geometry the host tracks: the component's own size (bbox — what the canvas
// fits to), the iframe element size (frame — grown to fit popovers), and where
// #root sits inside the frame (offset). Resting: frame == bbox, offset == 0.
interface FrameGeo {
  bboxW: number
  bboxH: number
  frameW: number
  frameH: number
  offsetX: number
  offsetY: number
}

const baseIframeStyle: CSSProperties = {
  display: "block",
  border: "none",
  background: "transparent",
}

export function IframeMount({
  manifestId,
  instanceId,
  props,
  title,
  onBbox,
  onError,
}: IframeMountProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [geo, setGeo] = useState<FrameGeo>({
    bboxW: INITIAL_W,
    bboxH: INITIAL_H,
    frameW: INITIAL_W,
    frameH: INITIAL_H,
    offsetX: 0,
    offsetY: 0,
  })
  const [ready, setReady] = useState(false)
  // Latest props in a ref so the message handler doesn't capture stale
  // closures, AND so `ready` can flush whatever the latest props are at the
  // moment the iframe finishes loading.
  const propsRef = useRef(props)
  propsRef.current = props

  const postToIframe = useCallback((msg: HostToIframe) => {
    const cw = iframeRef.current?.contentWindow
    if (!cw) return
    cw.postMessage(msg, "*") // opaque-origin sandbox; "*" is the only viable target
  }, [])

  // Window message listener — host side of the protocol.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const cw = iframeRef.current?.contentWindow
      if (!cw || event.source !== cw) return
      if (!isIframeToHost(event.data)) return
      const m = event.data
      switch (m.kind) {
        case "ready": {
          setReady(true)
          const b = clampBbox(m.bbox)
          // May be {0,0} if ready arrives pre-render — keep the iframe at 1×1
          // until the first non-zero size.
          if (b.width > 0 && b.height > 0) {
            setGeo({
              bboxW: b.width,
              bboxH: b.height,
              frameW: b.width,
              frameH: b.height,
              offsetX: 0,
              offsetY: 0,
            })
          }
          onBbox?.(b, "ready")
          postToIframe({
            v: IFRAME_PROTOCOL_VERSION,
            kind: "init",
            props: propsRef.current,
          })
          break
        }
        case "resize": {
          const b = clampBbox(m.bbox)
          if (b.width > 0 && b.height > 0) {
            // frame/offset carry the overflow grow; absent → resting (frame ==
            // bbox). Never let the frame be smaller than the component.
            const fr = m.frame ? clampBbox(m.frame) : b
            const off = m.offset ?? { x: 0, y: 0 }
            setGeo({
              bboxW: b.width,
              bboxH: b.height,
              frameW: Math.max(fr.width, b.width),
              frameH: Math.max(fr.height, b.height),
              offsetX: Math.max(0, off.x),
              offsetY: Math.max(0, off.y),
            })
          }
          onBbox?.(b, "resize")
          break
        }
        case "error":
          onError?.(m.message)
          break
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [onBbox, onError, postToIframe])

  // When props change after ready, push setProps. Pre-ready changes get
  // flushed inside the `ready` handler from propsRef.
  useEffect(() => {
    if (!ready) return
    postToIframe({
      v: IFRAME_PROTOCOL_VERSION,
      kind: "setProps",
      props,
    })
  }, [props, ready, postToIframe])

  // Telemetry — append one component_views row per mount (architecture-brief
  // §11 day-one telemetry). RLS allows the insert only for workspace members,
  // so anonymous viewers are dropped at the database boundary; we still
  // fire-and-forget here without surfacing errors to the canvas.
  useEffect(() => {
    let cancelled = false
    const supabase = createSupabaseBrowserClient()
    supabase
      .from("component_views")
      .insert({ instance_id: instanceId, manifest_id: manifestId })
      .then(({ error }) => {
        if (cancelled) return
        if (error && process.env.NODE_ENV !== "production") {
          console.debug("[component_views] insert blocked:", error.message)
        }
      })
    return () => {
      cancelled = true
    }
  }, [instanceId, manifestId])

  const iframeStyle = useMemo<CSSProperties>(() => {
    // Keep #root visually pinned where the canvas placed it while the frame
    // grows around it. The wrapper (stage-content) centers the grown frame on
    // the anchor via translate(-50%,-50%); shift the iframe back by half the
    // growth so #root's center stays put. Resize is INSTANT (no transition):
    // animating width/height makes Floating UI re-place the popover every frame
    // for the animation, which reads as jitter. One instant resize → one
    // reposition. The grown iframe area is transparent, so it isn't seen.
    const tx = (geo.frameW - geo.bboxW) / 2 - geo.offsetX
    const ty = (geo.frameH - geo.bboxH) / 2 - geo.offsetY
    return {
      ...baseIframeStyle,
      width: `${geo.frameW}px`,
      height: `${geo.frameH}px`,
      transform: `translate(${tx}px, ${ty}px)`,
    }
  }, [geo])

  return (
    <iframe
      ref={iframeRef}
      // The `manifestId` is the React key on the parent (stage-content), so
      // a manifest swap unmounts/remounts this whole element — no stale
      // postMessage state can leak across selections.
      src={`/preview/${manifestId}`}
      sandbox="allow-scripts"
      // Browsers default iframes to scrollable; the component should fit
      // exactly within the iframe so no scrollbar should ever appear.
      scrolling="no"
      title={title ?? "Component preview"}
      style={iframeStyle}
      // `referrerpolicy="no-referrer"` matches the route's response header —
      // belt-and-braces against referer leaks into the storage URL.
      referrerPolicy="no-referrer"
    />
  )
}

function clampBbox(b: IframeBbox): IframeBbox {
  return {
    width: Math.max(0, Math.min(MAX_DIMENSION, b.width || 0)),
    height: Math.max(0, Math.min(MAX_DIMENSION, b.height || 0)),
  }
}

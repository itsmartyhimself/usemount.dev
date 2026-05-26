// Narrow, versioned postMessage protocol between the host canvas and the
// sandboxed preview iframe (Step 4.3).
//
// Security posture: the iframe is mounted with `sandbox="allow-scripts"` and
// served via a route that sets a strict CSP. The host MUST treat every
// IframeToHost message as untrusted: validate the discriminant + shape, then
// ignore unknown kinds. NEVER eval / new Function / dangerouslySetInnerHTML on
// any payload field. Conversely, the iframe MUST validate HostToIframe the
// same way before applying.
//
// Versioned (`v: 1`) so we can roll forward without breaking older bundles —
// a v2 host can still talk to a v1 iframe by gating on the `v` field.

export const IFRAME_PROTOCOL_VERSION = 1

export interface IframeBbox {
  width: number
  height: number
}

/** Pixel offset of #root's top-left corner within the (possibly grown) frame. */
export interface IframeOffset {
  x: number
  y: number
}

/** Messages the host sends to the iframe. */
export type HostToIframe =
  | { v: 1; kind: "init"; props: Record<string, unknown> }
  | { v: 1; kind: "setProps"; props: Record<string, unknown> }

/**
 * Messages the iframe sends to the host.
 *
 * `resize.bbox` is always the COMPONENT's own size (#root) — the canvas fits /
 * zooms / bounds against this, so opening a popover never moves or rescales the
 * component. The optional `frame`/`offset` carry the overflow grow: when a
 * popover/tooltip portals outside #root (the iframe is a hard clip boundary),
 * the iframe reports the union size it needs (`frame`) and where #root sits
 * inside it (`offset`). The host sizes the iframe element to `frame` and shifts
 * it so #root stays visually pinned. Absent (old bundles / resting state) →
 * frame == bbox, offset == {0,0}: identical to the pre-overflow behavior.
 */
export type IframeToHost =
  | { v: 1; kind: "ready"; bbox: IframeBbox }
  | {
      v: 1
      kind: "resize"
      bbox: IframeBbox
      frame?: IframeBbox
      offset?: IframeOffset
    }
  | { v: 1; kind: "error"; message: string }

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null
}

function isBbox(x: unknown): x is IframeBbox {
  return (
    isRecord(x) &&
    typeof x.width === "number" &&
    typeof x.height === "number" &&
    Number.isFinite(x.width) &&
    Number.isFinite(x.height) &&
    x.width >= 0 &&
    x.height >= 0
  )
}

function isOffset(x: unknown): x is IframeOffset {
  return (
    isRecord(x) &&
    typeof x.x === "number" &&
    typeof x.y === "number" &&
    Number.isFinite(x.x) &&
    Number.isFinite(x.y)
  )
}

export function isHostToIframe(m: unknown): m is HostToIframe {
  if (!isRecord(m)) return false
  if (m.v !== IFRAME_PROTOCOL_VERSION) return false
  switch (m.kind) {
    case "init":
    case "setProps":
      return isRecord(m.props)
    default:
      return false
  }
}

export function isIframeToHost(m: unknown): m is IframeToHost {
  if (!isRecord(m)) return false
  if (m.v !== IFRAME_PROTOCOL_VERSION) return false
  switch (m.kind) {
    case "ready":
      return isBbox(m.bbox)
    case "resize":
      // bbox required; frame/offset optional (additive — old bundles omit them).
      if (!isBbox(m.bbox)) return false
      if (m.frame !== undefined && !isBbox(m.frame)) return false
      if (m.offset !== undefined && !isOffset(m.offset)) return false
      return true
    case "error":
      return typeof m.message === "string"
    default:
      return false
  }
}

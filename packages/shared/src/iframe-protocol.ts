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

/** Messages the host sends to the iframe. */
export type HostToIframe =
  | { v: 1; kind: "init"; props: Record<string, unknown> }
  | { v: 1; kind: "setProps"; props: Record<string, unknown> }

/** Messages the iframe sends to the host. */
export type IframeToHost =
  | { v: 1; kind: "ready"; bbox: IframeBbox }
  | { v: 1; kind: "resize"; bbox: IframeBbox }
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
    case "resize":
      return isBbox(m.bbox)
    case "error":
      return typeof m.message === "string"
    default:
      return false
  }
}

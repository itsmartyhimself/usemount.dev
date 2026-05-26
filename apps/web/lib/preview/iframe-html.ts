// Pure helpers for the iframe preview route. Factored out so the harness
// (apps/api/scripts/verify-iframe.ts) can assert on the CSP string and HTML
// shape without spinning up the Next runtime.

export interface RenderIframeOpts {
  /** Random base64 string per request — re-used on inline <style>, importmap, bootstrap. */
  nonce: string
  /** Manifest title (typically the slug). HTML-escaped before injection. */
  title: string
  /** Signed Storage URL for the component bundle (JS, ESM). */
  bundleUrl: string
  /** Signed Storage URL for per-component CSS, if the bundle emitted one. */
  perComponentCssUrl: string | null
  /** Signed Storage URL for the instance globals.css, if uploaded. */
  globalsCssUrl: string | null
  /**
   * Step 5.3 + 5.4 — signed Storage URL for the instance providers bundle.
   * Null when the worker detected no known providers AND no canvas.providers.tsx
   * was supplied; the bootstrap then renders the customer component bare
   * (PR7 behavior, no regression). When present, the bootstrap imports the
   * default export `Providers({ children })` and wraps every render with it.
   */
  providersUrl: string | null
  /**
   * PR19 — signed Storage URL for a sibling `<Component>.preview.tsx` example
   * bundle, or null. When present, the bootstrap renders the example's default
   * export (a real, self-contained usage that supplies the children/props a
   * contentless composite needs) INSTEAD of the bare component bundle. The
   * example is bundled exactly like a component (React externalized to the
   * iframe runtime), so it loads through the same importmap + sandbox.
   */
  previewUrl: string | null
  /** Wire version — kept in sync with packages/shared/src/iframe-protocol.ts. */
  protocolVersion: number
}

/**
 * CSP — the iframe's outer-most defense. Inline scripts use the nonce; the
 * bundle/CSS load over `script-src`/`style-src` from the Storage host;
 * `connect-src 'none'` blocks fetch / XHR / WebSocket exfiltration.
 * `unsafe-inline` is required on style-src ONLY (customer components ship
 * inline `style={{ ... }}` props — see CONVENTIONS.md).
 */
export function buildCsp(nonce: string, storageHost: string): string {
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}' https://${storageHost}`,
    `style-src 'self' 'unsafe-inline' https://${storageHost}`,
    `img-src 'self' data: blob: https://${storageHost}`,
    `font-src 'self' data: https://${storageHost}`,
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join("; ")
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;")
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c")
}

export function renderIframeHtml(opts: RenderIframeOpts): string {
  const titleSafe = escapeHtml(opts.title)
  const links: string[] = []
  if (opts.globalsCssUrl) {
    links.push(`<link rel="stylesheet" href="${escapeAttr(opts.globalsCssUrl)}">`)
  }
  if (opts.perComponentCssUrl) {
    links.push(
      `<link rel="stylesheet" href="${escapeAttr(opts.perComponentCssUrl)}">`,
    )
  }

  // JSON-in-HTML escape — `JSON.stringify` doesn't encode `<`, so a signed
  // URL containing `</script>` would close the host script early. Replace
  // every `<` with its `<` JSON unicode escape (round-trips identically
  // at runtime but can't terminate the surrounding <script> tag). Applied to
  // every JSON.stringify result interpolated into a <script> body below.
  const importmap = jsonForScript({
    imports: {
      react: "/preview-runtime/react.mjs",
      "react-dom": "/preview-runtime/react-dom.mjs",
      "react-dom/client": "/preview-runtime/react-dom-client.mjs",
      "react/jsx-runtime": "/preview-runtime/react-jsx-runtime.mjs",
    },
  })

  // Bootstrap module — every identifier is local; the only thing crossing
  // into customer space is the dynamic imports (bundle + providers) and the
  // component invocation. Heuristic export discovery for the component
  // handles `export default` AND the first PascalCase function export (PR6's
  // introspect picks the same first PascalCase, so the names line up on the
  // dogfood + REV-Plugin matrix).
  //
  // Step 5.3 + 5.4 — when PROVIDERS_URL is non-null, the bootstrap loads it
  // in parallel with the component bundle and wraps every render in the
  // provider tree. The providers contract is strict: the bundle MUST default-
  // export a function `Providers({ children })`. The auto-emit in apps/api
  // src/build/providers.ts produces this shape; customer canvas.providers.tsx
  // override files are documented in apps/web/CONVENTIONS.md to match.
  const bootstrap = `
import * as React from "react"
import { createRoot } from "react-dom/client"

const PROTOCOL_VERSION = ${opts.protocolVersion}
const BUNDLE_URL = ${jsonForScript(opts.bundleUrl)}
const PREVIEW_URL = ${jsonForScript(opts.previewUrl)}
// Render the preview EXAMPLE when one exists (it supplies its own children/
// props), else the bare component bundle. Same module shape either way — a
// default or first-PascalCase export — so pickComponent handles both.
const COMPONENT_URL = PREVIEW_URL || BUNDLE_URL
const PROVIDERS_URL = ${jsonForScript(opts.providersUrl)}

const rootEl = document.getElementById("root")
const root = createRoot(rootEl)
let Component = null
let Providers = null
let mounted = false
// Set once the component renders. After that, window-level error /
// unhandledrejection events are NOT surfaced as render failures — they're
// overwhelmingly ambient noise from browser extensions injected into the page
// (e.g. MetaMask's inpage.js posting "Failed to connect to MetaMask"), not the
// component's fault. Real mount errors are caught synchronously below.
let renderedOk = false

function postToHost(msg) {
  parent.postMessage(msg, "*")
}

function isHostMessage(m) {
  if (!m || typeof m !== "object") return false
  if (m.v !== PROTOCOL_VERSION) return false
  if (m.kind !== "init" && m.kind !== "setProps") return false
  return m.props && typeof m.props === "object"
}

function isComponent(v) {
  // Plain function components, plus exotic ones — forwardRef/memo return an
  // OBJECT carrying a $$typeof tag, not a function, so a function-only check
  // wrongly rejects them ("bundle did not export a PascalCase function").
  return typeof v === "function" || (!!v && typeof v === "object" && "$$typeof" in v)
}

function pickComponent(mod) {
  if (mod && isComponent(mod.default)) return mod.default
  for (const [k, v] of Object.entries(mod || {})) {
    if (/^[A-Z]/.test(k) && isComponent(v)) return v
  }
  return null
}

function pickProviders(mod) {
  if (mod && typeof mod.default === "function") return mod.default
  return null
}

function reportBbox() {
  const r = rootEl.getBoundingClientRect()
  return { width: r.width, height: r.height }
}

function safeRender(props) {
  if (!Component) return
  try {
    const tree = React.createElement(Component, props)
    const wrapped = Providers ? React.createElement(Providers, null, tree) : tree
    root.render(wrapped)
    renderedOk = true
  } catch (e) {
    postToHost({ v: PROTOCOL_VERSION, kind: "error", message: String((e && e.message) || e) })
  }
}

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return
  const m = event.data
  if (!isHostMessage(m)) return
  if (m.kind === "init") {
    if (mounted) return
    mounted = true
    safeRender(m.props)
  } else if (m.kind === "setProps") {
    if (!mounted) return
    safeRender(m.props)
  }
})

// --- Overflow: popovers/tooltips portal OUTSIDE #root (into <body>) and paint
// beyond its box; the iframe is a hard clip boundary, so to SHOW them we grow
// the FRAME to the union of #root + the floating content (the host grows the
// iframe element and shifts it so #root stays pinned, snapping back on close).
// We target the Radix Popper wrapper + ARIA roles — NOT every body node — so a
// full-viewport dismiss layer can't inflate the union into a feedback loop.
//
// bbox stays the component's own size so the canvas never zooms. #root is glued
// to the iframe's top-left (body margin:0) and Floating UI keeps content inside
// the viewport (origin = #root's corner), so the union only ever extends
// DOWN/RIGHT — offset is therefore always {0,0} and the host's (frame-bbox)/2
// shift pins #root. (No pre-grow: it would have to lie about the offset and
// bounce the component for a frame. If a popover bigger than the resting
// viewport ever needs room ABOVE/LEFT, push #root with body padding — PR21.)
const OVERLAY_SELECTOR = "[data-radix-popper-content-wrapper],[data-floating-ui-portal],[role=tooltip],[role=menu],[role=listbox],[role=dialog]"

function measureFrame() {
  const root = rootEl.getBoundingClientRect()
  let minX = root.left, minY = root.top, maxX = root.right, maxY = root.bottom
  let hasOverlay = false
  for (const el of document.querySelectorAll(OVERLAY_SELECTOR)) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    hasOverlay = true
    if (r.left < minX) minX = r.left
    if (r.top < minY) minY = r.top
    if (r.right > maxX) maxX = r.right
    if (r.bottom > maxY) maxY = r.bottom
  }
  return {
    bbox: { width: Math.round(root.width), height: Math.round(root.height) },
    frame: { width: Math.round(maxX - minX), height: Math.round(maxY - minY) },
    offset: { x: Math.round(root.left - minX), y: Math.round(root.top - minY) },
    hasOverlay,
  }
}

// Dedup identical posts — the MutationObserver fires on every Floating UI style
// tick, but the frame only changes when a popover opens/closes/resizes.
let lastKey = ""
function postFrame(bbox, frame, offset) {
  if (bbox.width <= 0 && bbox.height <= 0) return
  const key = bbox.width + "x" + bbox.height + " " + frame.width + "x" + frame.height + " " + offset.x + "," + offset.y
  if (key === lastKey) return
  lastKey = key
  postToHost({ v: PROTOCOL_VERSION, kind: "resize", bbox, frame, offset })
}

let rafId = 0
function syncFrame() {
  rafId = 0
  const m = measureFrame()
  if (m.hasOverlay) {
    // A popover/tooltip is open — grow the frame to the union containing it.
    postFrame(m.bbox, m.frame, m.offset)
  } else {
    // Resting (or just closed) — frame == the component box, no offset.
    postFrame(m.bbox, m.bbox, { x: 0, y: 0 })
  }
}

function scheduleSync() {
  if (rafId) return
  rafId = requestAnimationFrame(syncFrame)
}

const ro = new ResizeObserver(scheduleSync)
ro.observe(rootEl)
ro.observe(document.body)
// Popovers portal in/out as <body> subtree mutations and reposition via inline
// style — watch both so we react when one opens/closes/moves even though #root
// itself didn't change size.
const mo = new MutationObserver(scheduleSync)
mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "data-state", "data-side"] })

window.addEventListener("error", (event) => {
  if (renderedOk) return
  postToHost({ v: PROTOCOL_VERSION, kind: "error", message: String(event.message || event.error || "uncaught error") })
})
window.addEventListener("unhandledrejection", (event) => {
  if (renderedOk) return
  const reason = event.reason
  postToHost({ v: PROTOCOL_VERSION, kind: "error", message: String((reason && reason.message) || reason || "unhandled promise rejection") })
})

;(async () => {
  try {
    const bundleP = import(COMPONENT_URL)
    const providersP = PROVIDERS_URL ? import(PROVIDERS_URL) : Promise.resolve(null)
    const [mod, providersMod] = await Promise.all([bundleP, providersP])
    Component = pickComponent(mod)
    if (!Component) {
      throw new Error("bundle did not export a PascalCase function or default")
    }
    if (providersMod) {
      Providers = pickProviders(providersMod)
      if (!Providers) {
        throw new Error("providers bundle did not export a default function — see apps/web/CONVENTIONS.md for canvas.providers.tsx shape")
      }
    }
    postToHost({ v: PROTOCOL_VERSION, kind: "ready", bbox: reportBbox() })
  } catch (e) {
    postToHost({ v: PROTOCOL_VERSION, kind: "error", message: String((e && e.message) || e) })
  }
})()
`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${titleSafe} preview</title>
<style nonce="${opts.nonce}">
html, body { margin: 0; padding: 0; background: transparent; color-scheme: light dark; }
#root { display: inline-block; vertical-align: top; }
</style>
${links.join("\n")}
<script type="importmap" nonce="${opts.nonce}">${importmap}</script>
</head>
<body>
<div id="root"></div>
<script type="module" nonce="${opts.nonce}">${bootstrap}</script>
</body>
</html>`
}

export function renderErrorHtml(message: string): string {
  const safe = escapeHtml(message)
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Preview error</title><style>html,body{margin:0;padding:0;background:#fafafa;font:14px system-ui;}main{display:grid;place-items:center;height:100vh;color:#666;padding:24px;text-align:center;}</style></head><body><main>${safe}</main></body></html>`
}

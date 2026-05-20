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
  // into customer space is the dynamic import + the component invocation.
  // Heuristic export discovery handles `export default` AND the first
  // PascalCase function export (PR6's introspect picks the same first
  // PascalCase, so the names line up on the dogfood + REV-Plugin matrix).
  const bootstrap = `
import * as React from "react"
import { createRoot } from "react-dom/client"

const PROTOCOL_VERSION = ${opts.protocolVersion}
const BUNDLE_URL = ${jsonForScript(opts.bundleUrl)}

const rootEl = document.getElementById("root")
const root = createRoot(rootEl)
let Component = null
let mounted = false

function postToHost(msg) {
  parent.postMessage(msg, "*")
}

function isHostMessage(m) {
  if (!m || typeof m !== "object") return false
  if (m.v !== PROTOCOL_VERSION) return false
  if (m.kind !== "init" && m.kind !== "setProps") return false
  return m.props && typeof m.props === "object"
}

function pickComponent(mod) {
  if (mod && typeof mod.default === "function") return mod.default
  for (const [k, v] of Object.entries(mod || {})) {
    if (typeof v === "function" && /^[A-Z]/.test(k)) return v
  }
  return null
}

function reportBbox() {
  const r = rootEl.getBoundingClientRect()
  return { width: r.width, height: r.height }
}

function safeRender(props) {
  if (!Component) return
  try {
    root.render(React.createElement(Component, props))
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

const ro = new ResizeObserver(() => {
  const bbox = reportBbox()
  if (bbox.width > 0 || bbox.height > 0) {
    postToHost({ v: PROTOCOL_VERSION, kind: "resize", bbox })
  }
})
ro.observe(rootEl)

window.addEventListener("error", (event) => {
  postToHost({ v: PROTOCOL_VERSION, kind: "error", message: String(event.message || event.error || "uncaught error") })
})
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason
  postToHost({ v: PROTOCOL_VERSION, kind: "error", message: String((reason && reason.message) || reason || "unhandled promise rejection") })
})

;(async () => {
  try {
    const mod = await import(BUNDLE_URL)
    Component = pickComponent(mod)
    if (!Component) {
      throw new Error("bundle did not export a PascalCase function or default")
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

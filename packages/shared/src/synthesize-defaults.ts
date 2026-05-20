// Synthesize sensible defaultProps from a BuildManifestControls schema.
//
// PR6's introspect engine emits the control shape per prop, but does NOT
// emit default VALUES — those live in the customer's component code (default
// parameter values, optional props, etc.) and the checker doesn't evaluate
// them. For the iframe canvas to mount the component with non-broken initial
// props, we synthesize:
//   - variants/sizes/forms: first option string
//   - booleans: false
//   - slots: undefined (React ignores undefined children)
//   - strings: empty string
//   - numbers: 0
//   - handlers: a no-op function (kept inside the iframe — never crosses
//     postMessage; the host substitutes a sentinel name when sending props)
//   - objects: undefined (typed read-only; user can't set, customer code
//     should treat as optional)
//
// The customer's component will receive these defaults; combined with the
// component's own default parameter values, the iframe gets a reasonable
// preview from the first frame. The properties panel then lets the user
// override any field that has an interactive widget.

import type { BuildManifestControls } from "./build-manifest.js"

export function synthesizeDefaultProps(
  controls: BuildManifestControls,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (controls.variants && controls.variants.options.length > 0) {
    out[controls.variants.prop] = controls.variants.options[0]
  }
  if (controls.sizes && controls.sizes.options.length > 0) {
    out[controls.sizes.prop] = controls.sizes.options[0]
  }
  if (controls.forms && controls.forms.options.length > 0) {
    out[controls.forms.prop] = controls.forms.options[0]
  }
  for (const b of controls.booleans) out[b] = false
  for (const s of controls.strings) out[s.prop] = ""
  for (const n of controls.numbers) out[n.prop] = 0
  // Handlers, slots, objects: leave UNDEFINED so the customer component's
  // own default parameter values + optionality semantics take over. Sending
  // an explicit no-op handler would shadow a customer default like
  // `onClick = () => alert('hi')` that the preview should show.
  return out
}

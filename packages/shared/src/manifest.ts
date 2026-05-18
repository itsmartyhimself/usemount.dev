import type { ReactNode } from "react"

export interface ComponentManifestControls<P> {
  variants?: { prop: keyof P & string; options: string[] }
  sizes?: { prop: keyof P & string; options: string[] }
  forms?: { prop: keyof P & string; options: string[] }
  booleans?: Array<keyof P & string>
  slots?: Array<{ prop: keyof P & string; label: string }>
}

export interface ComponentManifest<P = Record<string, unknown>> {
  id: string
  render: (props: P) => ReactNode
  defaultProps: P
  controls: ComponentManifestControls<P>
}

// Type-erased storage shape. Each manifest stays strictly typed where it's
// defined; the registry holds them opaquely so a single map can carry mixed
// component shapes. Consumers re-narrow via the manifest's own render().
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyComponentManifest = ComponentManifest<any>

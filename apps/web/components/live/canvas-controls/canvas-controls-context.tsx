"use client"

// PR7 (Step 4.3): the manifest source moved from the demo `getManifest()`
// lookup over the in-host MANIFESTS map to the live `manifests` Map exposed
// by SidebarPanelProvider (which gets it server-side from the
// component_manifests table for the current instance). The render-side
// ComponentManifest no longer carries a `render` field — the canvas mounts
// an iframe instead, the controls shape is the BuildManifestControls the
// PR6 worker emits, and `defaultProps` is synthesized from controls (see
// packages/shared/src/synthesize-defaults.ts).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import type { ComponentManifest } from "@usemount/shared"
import { useSidebarPanelContext } from "@/components/live/sidebar-panel"

type PropMap = Record<string, unknown>

type CanvasControlsContextValue = {
  manifest: ComponentManifest | null
  props: PropMap
  setProp: (key: string, value: unknown) => void
  reset: () => void
}

const CanvasControlsContext = createContext<CanvasControlsContextValue | null>(null)

export function useCanvasControls() {
  const ctx = useContext(CanvasControlsContext)
  if (!ctx) {
    throw new Error("useCanvasControls must be used inside CanvasControlsProvider")
  }
  return ctx
}

export function CanvasControlsProvider({
  selectedId,
  children,
}: {
  selectedId: string | null
  children: ReactNode
}) {
  const { manifests } = useSidebarPanelContext()
  const manifest = useMemo(
    () => (selectedId ? (manifests.get(selectedId) ?? null) : null),
    [manifests, selectedId],
  )
  const [props, setProps] = useState<PropMap>(() =>
    manifest ? { ...manifest.defaultProps } : {},
  )

  useEffect(() => {
    setProps(manifest ? { ...manifest.defaultProps } : {})
  }, [manifest])

  const setProp = useCallback((key: string, value: unknown) => {
    setProps((prev) => ({ ...prev, [key]: value }))
  }, [])

  const reset = useCallback(() => {
    setProps(manifest ? { ...manifest.defaultProps } : {})
  }, [manifest])

  const value = useMemo<CanvasControlsContextValue>(
    () => ({ manifest, props, setProp, reset }),
    [manifest, props, setProp, reset],
  )

  return (
    <CanvasControlsContext.Provider value={value}>
      {children}
    </CanvasControlsContext.Provider>
  )
}

"use client"

// PR7 (Step 4.3): the sidebar registry is sourced from live `component_manifests`
// rows, fetched server-side by the InstancePage and passed in via
// `initialRegistry` + `initialManifests`. The provider is otherwise unchanged
// from the demo-era version: same context shape, same actions, same hover/
// scroll/highlight mechanics. Only the data source moved.
//
// `initialManifests` is the per-leaf-id Map the canvas-controls-context reads
// when the user selects a leaf (replacing the old getManifest() lookup
// against MANIFESTS in lib/registry/manifests.ts). Both props default to
// empty-but-valid shapes so callers without instance context (e.g. legacy
// /playground mounts) keep rendering.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react"
import type { ComponentManifest } from "@usemount/shared"
import type { Registry } from "@/lib/registry/types"
import { searchRegistry, type SearchMatch } from "@/lib/registry/search"
import { fetchInstanceRegistryOrThrow } from "@/lib/registry/from-supabase"
import { createSupabaseBrowserClient } from "@/lib/supabase/client"
import { SIDEBAR_COLLAPSED_STORAGE_KEY } from "./sidebar-panel.config"

export interface SidebarActions {
  toggleExpanded: (id: string) => void
  setSearchQuery: (query: string) => void
  openDoc: (id: string) => void
  closeDoc: () => void
  // PR19 — the folder/component picker modal (mirrors openDoc/closeDoc). Both
  // the footer trigger and the empty-state CTA call openPicker; one
  // FolderPickerModal (mounted in AppShell) reads pickerOpen.
  openPicker: () => void
  closePicker: () => void
  setCollapsed: (next: boolean) => void
  toggleCollapsed: () => void
  expandIfCollapsed: () => void
  // PR22 — a rebuild is in flight (published by the picker). Drives the
  // "Building…" affordance on the trigger when the modal is detached.
  setBuilding: (next: boolean) => void
  // PR22 — re-fetch component_manifests for the instance and swap the live
  // registry/manifests in place (replaces the old window.location.reload()).
  reseed: () => Promise<void>
}

export type RowRegistry = Map<string, HTMLElement>

export interface SidebarPanelContextValue {
  registry: Registry
  /** Manifest lookup keyed by leaf id (= component_manifests.id). */
  manifests: Map<string, ComponentManifest>
  expandedIds: Set<string>
  searchQuery: string
  searchMatch: SearchMatch | null
  effectiveExpandedIds: Set<string>
  openDocId: string | null
  pickerOpen: boolean
  collapsed: boolean
  building: boolean
  actions: SidebarActions
  hoverId: string | null
  setHoverId: (id: string | null) => void
  registerRow: (id: string, el: HTMLElement | null) => void
  rowRegistry: MutableRefObject<RowRegistry>
  registryVersion: number
  wrapperRef: MutableRefObject<HTMLDivElement | null>
}

const SidebarPanelContext = createContext<SidebarPanelContextValue | null>(null)

const EMPTY_REGISTRY: Registry = {
  sections: [],
  folders: [],
  leaves: [],
  topPages: [],
  team: { id: "", name: "", plan: "" },
  user: { name: "", email: "" },
}

export interface SidebarPanelProviderProps {
  children: ReactNode
  /**
   * Route-derived instance id. Needed so the provider can re-fetch the
   * registry client-side after a rebuild (`reseed`). Optional — legacy /
   * playground mounts pass none and simply never reseed.
   */
  instanceId?: string
  /**
   * Pre-fetched sidebar shape. `Registry` is the demo-era tree shape; the
   * server-side `fetchInstanceRegistry` helper builds it from
   * component_manifests rows. Defaults to an empty registry so legacy /
   * playground mounts still render.
   */
  initialRegistry?: Registry
  /**
   * Pre-fetched manifest map keyed by leaf id. Defaults to an empty Map.
   */
  initialManifests?: Map<string, ComponentManifest>
}

export function SidebarPanelProvider({
  children,
  instanceId,
  initialRegistry,
  initialManifests,
}: SidebarPanelProviderProps) {
  // PR22 — registry/manifests are now live: `reseed()` swaps them in place when
  // a rebuild lands (replacing the full-page reload). Seeded from the server
  // props; updated client-side via the RLS-gated fetchInstanceRegistry.
  const [registry, setRegistry] = useState<Registry>(
    initialRegistry ?? EMPTY_REGISTRY,
  )
  const [manifests, setManifests] = useState<Map<string, ComponentManifest>>(
    initialManifests ?? new Map(),
  )
  const [building, setBuildingState] = useState(false)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const [searchQuery, setSearchQueryState] = useState<string>("")
  const [openDocId, setOpenDocId] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState<boolean>(false)

  const [collapsed, setCollapsedState] = useState<boolean>(false)
  const [collapsedReady, setCollapsedReady] = useState(false)

  const [hoverId, setHoverIdState] = useState<string | null>(null)
  const rowRegistry = useRef<RowRegistry>(new Map())
  const [registryVersion, setRegistryVersion] = useState(0)
  const wrapperRef = useRef<HTMLDivElement | null>(null)

  const setHoverId = useCallback((id: string | null) => {
    setHoverIdState((prev) => (prev === id ? prev : id))
  }, [])

  const registerRow = useCallback((id: string, el: HTMLElement | null) => {
    const reg = rowRegistry.current
    if (el) {
      if (reg.get(id) === el) return
      reg.set(id, el)
    } else {
      if (!reg.has(id)) return
      reg.delete(id)
    }
    setRegistryVersion((v) => v + 1)
  }, [])

  // SSR/hydration: load persisted collapsed state after mount so first client
  // render matches SSR (both see `false`).
  useEffect(() => {
    if (typeof window === "undefined") return
    try {
      const raw = window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)
      if (raw !== null) {
        const parsed = JSON.parse(raw)
        if (typeof parsed === "boolean") setCollapsedState(parsed)
      }
    } catch {
    } finally {
      setCollapsedReady(true)
    }
  }, [])

  useEffect(() => {
    if (!collapsedReady) return
    if (typeof window === "undefined") return
    try {
      window.localStorage.setItem(
        SIDEBAR_COLLAPSED_STORAGE_KEY,
        JSON.stringify(collapsed),
      )
    } catch {
    }
  }, [collapsed, collapsedReady])

  const searchMatch = useMemo(
    () => searchRegistry(registry, searchQuery),
    [registry, searchQuery],
  )

  const effectiveExpandedIds = useMemo(() => {
    if (!searchMatch) return expandedIds
    const combined = new Set(expandedIds)
    for (const id of searchMatch.ancestors) combined.add(id)
    return combined
  }, [expandedIds, searchMatch])

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const setSearchQuery = useCallback((query: string) => {
    setSearchQueryState(query)
  }, [])

  const openDoc = useCallback((id: string) => {
    setOpenDocId(id)
  }, [])

  const closeDoc = useCallback(() => {
    setOpenDocId(null)
  }, [])

  const openPicker = useCallback(() => {
    setPickerOpen(true)
  }, [])

  const closePicker = useCallback(() => {
    setPickerOpen(false)
  }, [])

  const setCollapsed = useCallback((next: boolean) => {
    setCollapsedState(next)
  }, [])

  const toggleCollapsed = useCallback(() => {
    setCollapsedState((prev) => !prev)
  }, [])

  const expandIfCollapsed = useCallback(() => {
    setCollapsedState((prev) => (prev ? false : prev))
  }, [])

  const setBuilding = useCallback((next: boolean) => {
    setBuildingState((prev) => (prev === next ? prev : next))
  }, [])

  // Re-fetch the instance's manifests and swap the registry/manifests in place.
  // Preserve the existing user/team header info (not re-derived client-side).
  // On a transient fetch error, SKIP — never overwrite the live sidebar with
  // an empty registry (the throwing variant lets us tell error from genuinely
  // empty).
  const reseed = useCallback(async () => {
    if (!instanceId) return
    const supabase = createSupabaseBrowserClient()
    try {
      const next = await fetchInstanceRegistryOrThrow(supabase, instanceId)
      setRegistry((prev) => ({
        ...next.registry,
        team: prev.team,
        user: prev.user,
      }))
      setManifests(next.manifests)
    } catch (e) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[sidebar reseed]", (e as Error).message)
      }
    }
  }, [instanceId])

  // Collapse side effects — in an effect to keep the state updater StrictMode-safe.
  useEffect(() => {
    if (!collapsed) return
    setExpandedIds(new Set())
    if (typeof document !== "undefined") {
      const active = document.activeElement
      if (
        active instanceof HTMLElement &&
        active.closest("[aria-label='Component browser']")
      ) {
        active.blur()
      }
    }
  }, [collapsed])

  const actions = useMemo<SidebarActions>(
    () => ({
      toggleExpanded,
      setSearchQuery,
      openDoc,
      closeDoc,
      openPicker,
      closePicker,
      setCollapsed,
      toggleCollapsed,
      expandIfCollapsed,
      setBuilding,
      reseed,
    }),
    [
      toggleExpanded,
      setSearchQuery,
      openDoc,
      closeDoc,
      openPicker,
      closePicker,
      setCollapsed,
      toggleCollapsed,
      expandIfCollapsed,
      setBuilding,
      reseed,
    ],
  )

  const value = useMemo<SidebarPanelContextValue>(
    () => ({
      registry,
      manifests,
      expandedIds,
      searchQuery,
      searchMatch,
      effectiveExpandedIds,
      openDocId,
      pickerOpen,
      collapsed,
      building,
      actions,
      hoverId,
      setHoverId,
      registerRow,
      rowRegistry,
      registryVersion,
      wrapperRef,
    }),
    [
      registry,
      manifests,
      expandedIds,
      searchQuery,
      searchMatch,
      effectiveExpandedIds,
      openDocId,
      pickerOpen,
      collapsed,
      building,
      actions,
      hoverId,
      setHoverId,
      registerRow,
      registryVersion,
    ],
  )

  return (
    <SidebarPanelContext.Provider value={value}>
      {children}
    </SidebarPanelContext.Provider>
  )
}

export function useSidebarPanelContext(): SidebarPanelContextValue {
  const ctx = useContext(SidebarPanelContext)
  if (!ctx) {
    throw new Error("useSidebarPanelContext must be used inside <SidebarPanelProvider>.")
  }
  return ctx
}

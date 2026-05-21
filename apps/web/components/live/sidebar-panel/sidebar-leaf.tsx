"use client"

import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useCallback, useEffect, useRef } from "react"
import {
  SidebarMenuItem,
  SidebarMenuSubItem,
} from "@/components/imports/shadcn/sidebar"
import { Row } from "@/components/live/row"
import type { LeafRecord } from "@/lib/registry/types"
import { useSidebarPanel } from "./use-sidebar-panel"

interface SidebarLeafProps {
  leaf: LeafRecord
  depth?: 0 | 1
}

export function SidebarLeaf({ leaf, depth = 1 }: SidebarLeafProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { actions, registerRow, setHoverId, collapsed } = useSidebarPanel()
  const rowRef = useRef<HTMLButtonElement | HTMLAnchorElement | null>(null)

  // `collapsed` is in deps because Row swaps a Tooltip wrap around its inner
  // button when collapsed flips, which remounts the button at a new tree
  // position. Re-running this effect re-registers the fresh DOM node.
  useEffect(() => {
    registerRow(leaf.id, rowRef.current)
    return () => registerRow(leaf.id, null)
  }, [leaf.id, registerRow, collapsed])

  const selectedId = searchParams.get("component")
  const active = leaf.kind === "component" && selectedId === leaf.id

  const handleClick = useCallback(() => {
    if (leaf.disabled || leaf.loading) return
    if (collapsed) actions.expandIfCollapsed()
    if (leaf.kind === "doc") {
      actions.openDoc(leaf.id)
      return
    }
    const params = new URLSearchParams(searchParams.toString())
    params.set("component", leaf.id)
    router.push(`${pathname}?${params.toString()}`)
  }, [leaf, actions, pathname, router, searchParams, collapsed])

  const leading = (() => {
    if (leaf.kind === "nav") return { kind: "dot" } as const
    if (leaf.iconName) return { kind: "icon", icon: leaf.iconName } as const
    return { kind: "icon", icon: "cube" } as const
  })()

  // Step 5.6 — disposition note on greyed leaves. RSCs and build-failed
  // components both render disabled; the persistent tag tells them apart, and
  // the native `title` carries the full copy on hover (architecture-brief §3
  // failure modes 1 + 6).
  const disposition = (() => {
    if (leaf.manifestKind === "maybe-rsc") {
      return { tag: "Server", title: "Server component — not supported" }
    }
    if (leaf.manifestKind === "unsupported") {
      return { tag: "Failed", title: "This component couldn't be built" }
    }
    return null
  })()

  const trailing = disposition
    ? ({
        kind: "badge",
        content: <span title={disposition.title}>{disposition.tag}</span>,
      } as const)
    : ({ kind: "none" } as const)

  const rowNode = (
    <Row
      ref={rowRef}
      label={leaf.name}
      size={depth === 1 ? 28 : 32}
      variant={depth === 1 ? "menu-sub-button" : "menu-button"}
      leading={leading}
      trailing={trailing}
      active={active}
      disabled={leaf.disabled}
      loading={leaf.loading}
      onClick={handleClick}
      onHoverChange={(h) => {
        if (h) setHoverId(leaf.id)
      }}
      collapsed={collapsed}
      tooltipLabel={collapsed ? leaf.name : undefined}
    />
  )

  if (depth === 1) {
    return <SidebarMenuSubItem>{rowNode}</SidebarMenuSubItem>
  }

  return <SidebarMenuItem>{rowNode}</SidebarMenuItem>
}

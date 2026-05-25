"use client"

import type { CSSProperties } from "react"
import { UserFooter } from "@/components/live/user-footer"
import { FolderPickerTrigger } from "@/components/live/folder-picker"
import { useSidebarPanel } from "./use-sidebar-panel"
import { SidebarDivider } from "./sidebar-divider"

const wrapperStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  padding: "0 var(--spacing-3) var(--spacing-3) var(--spacing-3)",
}

export function SidebarFooterZone() {
  const { registry, collapsed } = useSidebarPanel()
  return (
    <div style={wrapperStyle}>
      <SidebarDivider />
      <FolderPickerTrigger />
      <UserFooter user={registry.user} collapsed={collapsed} />
    </div>
  )
}

"use client"

// Sidebar entry point to the folder/component picker. Lives in the footer zone;
// calls actions.openPicker() (the single FolderPickerModal is mounted in
// AppShell and reads pickerOpen). Collapses to an icon-only button on the rail.

import { useState, type CSSProperties } from "react"
import { Folders } from "@carbon/icons-react"
import { useSidebarPanel } from "@/components/live/sidebar-panel/use-sidebar-panel"

function buttonStyle(collapsed: boolean, hovered: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: collapsed ? "center" : "flex-start",
    gap: "var(--spacing-2)",
    width: "100%",
    paddingBlock: "var(--spacing-2)",
    paddingInline: collapsed ? "0" : "var(--spacing-2)",
    marginBlock: "var(--spacing-2)",
    borderRadius: "var(--radius-2)",
    border: 0,
    background: hovered ? "var(--color-bg-hover)" : "transparent",
    color: "var(--color-text-secondary)",
    cursor: "pointer",
  }
}

export function FolderPickerTrigger() {
  const { actions, collapsed } = useSidebarPanel()
  const [hovered, setHovered] = useState(false)

  return (
    <button
      type="button"
      onClick={() => actions.openPicker()}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={buttonStyle(collapsed, hovered)}
      aria-label="Choose folders to preview"
      title="Choose folders to preview"
    >
      <Folders size={16} style={{ flexShrink: 0 }} />
      {!collapsed ? (
        <span className="type-4 text-trim">Choose folders</span>
      ) : null}
    </button>
  )
}

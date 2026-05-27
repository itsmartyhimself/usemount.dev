"use client"

// Sidebar entry point to the folder/component picker. Lives in the footer zone;
// calls actions.openPicker() (the single FolderPickerModal is mounted in
// AppShell and reads pickerOpen). Collapses to an icon-only button on the rail.

import { useState, type CSSProperties } from "react"
import { Folders, InProgress } from "@carbon/icons-react"
import { useSidebarPanel } from "@/components/live/sidebar-panel/use-sidebar-panel"

// Mirrors the size-32 sidebar Row (row.config.ts) so the trigger reads as one
// of the component rows above it — same 32px height, spacing-3 padding + gap,
// radius-2. Collapsed: center the icon with spacing-2-5, like a collapsed Row.
function buttonStyle(collapsed: boolean, hovered: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: collapsed ? "center" : "flex-start",
    gap: "var(--spacing-3)",
    width: "100%",
    height: 32,
    boxSizing: "border-box",
    paddingBlock: "var(--spacing-2-5)",
    paddingInline: collapsed ? "var(--spacing-2-5)" : "var(--spacing-3)",
    marginBlock: "var(--spacing-1)",
    borderRadius: "var(--radius-2)",
    border: 0,
    background: hovered ? "var(--color-bg-hover)" : "transparent",
    color: "var(--color-text-secondary)",
    cursor: "pointer",
  }
}

export function FolderPickerTrigger() {
  const { actions, collapsed, building } = useSidebarPanel()
  const [hovered, setHovered] = useState(false)

  // While a (possibly detached) rebuild is running, the trigger becomes a live
  // "Building…" pill — still clickable to reopen the modal and watch progress.
  const label = building ? "Building…" : "Choose folders"

  return (
    <button
      type="button"
      onClick={() => actions.openPicker()}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...buttonStyle(collapsed, hovered),
        ...(building ? { color: "var(--color-text-primary)" } : null),
      }}
      aria-label={building ? "Rebuilding — open to view progress" : "Choose folders to preview"}
      title={building ? "Rebuilding…" : "Choose folders to preview"}
    >
      {building ? (
        <span className="icon-spin" style={{ display: "inline-flex", flexShrink: 0 }}>
          <InProgress size={16} />
        </span>
      ) : (
        <Folders size={16} style={{ flexShrink: 0 }} />
      )}
      {!collapsed ? <span className="type-4">{label}</span> : null}
    </button>
  )
}

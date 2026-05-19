"use client"

import type { CSSProperties } from "react"
import { SearchInput } from "@/components/live/search-input"
import { InstanceBreadcrumb } from "@/components/live/instance-breadcrumb"
import { useInstanceBranches } from "@/lib/dashboard/use-instance-branches"
import {
  SIDEBAR_EASE_OUT_SOFT,
  SIDEBAR_LABEL_EXIT_MS,
  SIDEBAR_WIDTH_DURATION_MS,
} from "./sidebar-panel.config"
import { useSidebarPanel } from "./use-sidebar-panel"
import { SidebarDivider } from "./sidebar-divider"

const headerStyle: CSSProperties = {
  padding: "var(--spacing-3) var(--spacing-3) 0 var(--spacing-3)",
  display: "flex",
  flexDirection: "column",
}

// Brand glyph slot. Replaces the old team/plan switcher — team + repo identity
// already lives in the breadcrumb above, so this slot carries the Mount mark.
// It is the one header element that stays visible when collapsed: the breadcrumb
// goes to max-height:0 and the search collapses to height:0, so in the 44px rail
// the glyph is the sole, centred element. The negative inline margin cancels the
// header's 8px side padding so the 36px glyph centres in the full rail instead
// of being clipped by the 28px padded content box.
function brandWrapStyle(collapsed: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: collapsed ? "center" : "flex-start",
    paddingBlock: "var(--spacing-3)",
    marginInline: collapsed ? "calc(-1 * var(--spacing-3))" : "0",
    transition: `margin ${SIDEBAR_WIDTH_DURATION_MS}ms ${SIDEBAR_EASE_OUT_SOFT}`,
  }
}

const glyphStyle: CSSProperties = {
  display: "block",
  height: 36,
  width: 36,
  flexShrink: 0,
  backgroundColor: "var(--color-text-primary)",
  WebkitMaskImage: "url(/SVGs/mount-glyph.svg)",
  maskImage: "url(/SVGs/mount-glyph.svg)",
  WebkitMaskRepeat: "no-repeat",
  maskRepeat: "no-repeat",
  WebkitMaskPosition: "center",
  maskPosition: "center",
  WebkitMaskSize: "contain",
  maskSize: "contain",
}

// Single element in both states — padding transitions with the aside so the
// search bar slides smoothly into its collapsed position. Collapsed it goes to
// zero height *and* width so it leaves no empty ghost box in the rail.
function searchRowStyle(collapsed: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    width: "100%",
    padding: collapsed
      ? "0"
      : "0 var(--spacing-3) var(--spacing-3) var(--spacing-3)",
    transition: `padding ${SIDEBAR_WIDTH_DURATION_MS}ms ${SIDEBAR_EASE_OUT_SOFT}`,
  }
}

function searchWrapStyle(collapsed: boolean): CSSProperties {
  const ms = SIDEBAR_LABEL_EXIT_MS
  return {
    flex: 1,
    minWidth: 0,
    maxWidth: collapsed ? 0 : 999,
    maxHeight: collapsed ? 0 : 80,
    opacity: collapsed ? 0 : 1,
    overflow: "hidden",
    transition: [
      `max-width ${ms}ms ${SIDEBAR_EASE_OUT_SOFT}`,
      `max-height ${ms}ms ${SIDEBAR_EASE_OUT_SOFT}`,
      `opacity ${ms}ms ${SIDEBAR_EASE_OUT_SOFT}`,
    ].join(", "),
  }
}

export function SidebarHeaderZone() {
  const { searchQuery, actions, collapsed } = useSidebarPanel()
  const { data: instanceData, onSwitchBranch } = useInstanceBranches()

  return (
    <div style={headerStyle}>
      <InstanceBreadcrumb
        data={instanceData}
        collapsed={collapsed}
        onSwitchBranch={onSwitchBranch}
      />
      <div style={brandWrapStyle(collapsed)}>
        <span role="img" aria-label="Mount" style={glyphStyle} />
      </div>
      <SidebarDivider />
      <div style={searchRowStyle(collapsed)}>
        <div style={searchWrapStyle(collapsed)}>
          <SearchInput
            value={searchQuery}
            onValueChange={actions.setSearchQuery}
            placeholder="Search"
          />
        </div>
      </div>
    </div>
  )
}

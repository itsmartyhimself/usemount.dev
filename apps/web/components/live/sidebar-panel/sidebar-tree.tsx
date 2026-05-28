"use client"

// TODO(ROADMAP: "Sidebar" → virtualize ~200 rows): the tree is rendered in full
// today. When registries grow, swap the inner SidebarMenu rendering for a
// virtualised list (react-virtual or equivalent).

import type { CSSProperties } from "react"
import { SidebarMenu } from "@/components/imports/shadcn/sidebar"
import type { LeafRecord } from "@/lib/registry/types"
import { SidebarDivider } from "./sidebar-divider"
import { SidebarLeaf } from "./sidebar-leaf"
import { SidebarSection } from "./sidebar-section"
import { useSidebarPanel } from "./use-sidebar-panel"

const topPagesWrapperStyle: CSSProperties = {
  padding: "var(--spacing-2) var(--spacing-3)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--spacing-1)",
}

export function SidebarTree() {
  const { registry, collapsed } = useSidebarPanel()
  const hasTopPages = registry.topPages.length > 0

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {hasTopPages && (
        <SidebarMenu style={topPagesWrapperStyle}>
          {registry.topPages.map((page) => {
            // Top pages reuse the doc-leaf form. sectionId is unused by
            // SidebarLeaf's doc path — "library" is a harmless placeholder.
            const asLeaf: LeafRecord = {
              id: page.id,
              name: page.label,
              kind: "doc",
              sectionId: "library",
              iconName: page.iconName,
              order: 0,
            }
            return <SidebarLeaf key={page.id} leaf={asLeaf} depth={0} />
          })}
        </SidebarMenu>
      )}
      {hasTopPages && !collapsed && <SidebarDivider />}
      {registry.sections.map((section, idx) => {
        const folders = registry.folders
          .filter((folder) => folder.sectionId === section.id)
          .sort((a, b) => a.order - b.order)
        const leaves = registry.leaves.filter(
          (leaf) => leaf.sectionId === section.id,
        )
        return (
          <div key={section.id}>
            {idx > 0 ? <div style={{ height: "var(--spacing-2)" }} /> : null}
            <SidebarSection
              section={section}
              folders={folders}
              leaves={leaves}
            />
          </div>
        )
      })}
    </div>
  )
}

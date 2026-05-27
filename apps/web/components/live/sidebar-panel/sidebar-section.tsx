"use client"

import type { CSSProperties } from "react"
import { SidebarGroup, SidebarMenu } from "@/components/imports/shadcn/sidebar"
import { SectionHeader } from "@/components/live/section-header"
import type {
  FolderRecord,
  LeafRecord,
  SectionRecord,
} from "@/lib/registry/types"
import { SidebarFolder } from "./sidebar-folder"
import { SidebarLeaf } from "./sidebar-leaf"
import {
  SIDEBAR_EASE_OUT_SOFT,
  SIDEBAR_LABEL_ENTER_MS,
  SIDEBAR_LABEL_EXIT_MS,
  SIDEBAR_WIDTH_DURATION_MS,
} from "./sidebar-panel.config"
import { useSidebarPanel } from "./use-sidebar-panel"

interface SidebarSectionProps {
  section: SectionRecord
  folders: FolderRecord[]
  leaves: LeafRecord[]
}

const emptyHintStyle: CSSProperties = {
  padding: "var(--spacing-2) var(--spacing-3)",
  color: "var(--color-text-tertiary)",
}

// Uses the grid-template-rows 0fr/1fr trick so height collapses without a
// measured pixel value. Browser-interpolated, no JS per frame.
function headerCollapseStyle(collapsed: boolean): CSSProperties {
  const labelMs = collapsed ? SIDEBAR_LABEL_EXIT_MS : SIDEBAR_LABEL_ENTER_MS
  return {
    display: "grid",
    gridTemplateRows: collapsed ? "0fr" : "1fr",
    opacity: collapsed ? 0 : 1,
    pointerEvents: collapsed ? "none" : undefined,
    transition: [
      `grid-template-rows ${SIDEBAR_WIDTH_DURATION_MS}ms ${SIDEBAR_EASE_OUT_SOFT}`,
      `opacity ${labelMs}ms ${SIDEBAR_EASE_OUT_SOFT}`,
    ].join(", "),
  }
}

export function SidebarSection({
  section,
  folders,
  leaves,
}: SidebarSectionProps) {
  const { searchMatch, collapsed } = useSidebarPanel()

  const filteredFolderIds = searchMatch
    ? new Set(
        folders
          .filter(
            (folder) =>
              searchMatch.folders.has(folder.id) ||
              searchMatch.ancestors.has(folder.id) ||
              leaves.some(
                (leaf) =>
                  leaf.folderId === folder.id &&
                  searchMatch.leaves.has(leaf.id),
              ),
          )
          .map((folder) => folder.id),
      )
    : null

  const displayFolders = filteredFolderIds
    ? folders.filter((folder) => filteredFolderIds.has(folder.id))
    : folders

  const displayLeaves = searchMatch
    ? leaves.filter((leaf) => searchMatch.leaves.has(leaf.id))
    : leaves

  // Build the nested tree: group visible folders by parentId and leaves by
  // folderId. A folder is a root when it has no parent (or its parent was
  // filtered out by search). Ordered by `order` (assigned alphabetically).
  const visibleFolderIds = new Set(displayFolders.map((f) => f.id))
  const childFoldersByParent = new Map<string, FolderRecord[]>()
  const rootFolders: FolderRecord[] = []
  for (const f of [...displayFolders].sort((a, b) => a.order - b.order)) {
    if (f.parentId && visibleFolderIds.has(f.parentId)) {
      const arr = childFoldersByParent.get(f.parentId) ?? []
      arr.push(f)
      childFoldersByParent.set(f.parentId, arr)
    } else {
      rootFolders.push(f)
    }
  }
  const leavesByFolder = new Map<string, LeafRecord[]>()
  for (const l of [...displayLeaves].sort((a, b) => a.order - b.order)) {
    if (!l.folderId) continue
    const arr = leavesByFolder.get(l.folderId) ?? []
    arr.push(l)
    leavesByFolder.set(l.folderId, arr)
  }

  return (
    <SidebarGroup>
      <div style={headerCollapseStyle(collapsed)}>
        <div style={{ overflow: "hidden", minHeight: 0 }}>
          <SectionHeader label={section.label} />
        </div>
      </div>
      <SidebarMenu>
        {section.kind === "folders" ? (
          <>
            {rootFolders.length === 0 ? (
              <li className="type-3" style={emptyHintStyle}>
                {collapsed
                  ? null
                  : searchMatch
                    ? "No matches in this section."
                    : "No folders yet."}
              </li>
            ) : (
              rootFolders.map((folder) => (
                <FolderNode
                  key={folder.id}
                  folder={folder}
                  childFoldersByParent={childFoldersByParent}
                  leavesByFolder={leavesByFolder}
                />
              ))
            )}
          </>
        ) : (
          <>
            {displayLeaves.length === 0 ? (
              <li className="type-3" style={emptyHintStyle}>
                {collapsed ? null : "No items."}
              </li>
            ) : (
              displayLeaves
                .sort((a, b) => a.order - b.order)
                .map((leaf) => (
                  <SidebarLeaf key={leaf.id} leaf={leaf} depth={0} />
                ))
            )}
          </>
        )}
      </SidebarMenu>
    </SidebarGroup>
  )
}

// Recursive folder node: renders its child folders (nested) then its direct
// leaves. Indentation comes from SidebarFolder's nested SidebarMenuSub margin,
// so depth needs no explicit prop. `hasChildren` covers folders OR leaves.
function FolderNode({
  folder,
  childFoldersByParent,
  leavesByFolder,
}: {
  folder: FolderRecord
  childFoldersByParent: Map<string, FolderRecord[]>
  leavesByFolder: Map<string, LeafRecord[]>
}) {
  const childFolders = childFoldersByParent.get(folder.id) ?? []
  const childLeaves = leavesByFolder.get(folder.id) ?? []
  const hasChildren = childFolders.length > 0 || childLeaves.length > 0
  return (
    <SidebarFolder folder={folder} hasChildren={hasChildren}>
      {childFolders.map((cf) => (
        <FolderNode
          key={cf.id}
          folder={cf}
          childFoldersByParent={childFoldersByParent}
          leavesByFolder={leavesByFolder}
        />
      ))}
      {childLeaves.map((leaf) => (
        <SidebarLeaf key={leaf.id} leaf={leaf} />
      ))}
    </SidebarFolder>
  )
}

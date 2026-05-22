"use client"

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react"
import { AnimatePresence, motion } from "framer-motion"
import { Collapsible } from "radix-ui"
import { BranchRow } from "@/components/live/branch-row"
import { DashboardListHeader } from "@/components/live/dashboard-list-header"
import { EmptyState } from "@/components/live/empty-state"
import { Greeting } from "@/components/live/greeting"
import { ListContainer } from "@/components/live/list-container"
import { OtherBranchesExpander } from "@/components/live/other-branches-expander"
import { RecentRepos } from "@/components/live/recent-repos"
import { RepoRow } from "@/components/live/repo-row"
import { ROW_SPRING } from "@/components/live/row/row.config"
import {
  useDashboardState,
  DashboardStateProvider,
} from "@/lib/dashboard/state"
import { synthesizeUnpinnedBranches } from "@/lib/dashboard/demo"
import type { Branch, Workspace } from "@/lib/dashboard/types"

// EmptyState is now data-derived (no ?state= URL contract). It must be decided
// inside the provider so it can read loading/repos. `loading` gates the
// empty-vs-content flash on first paint.
function DashboardGate() {
  const { loading, repos } = useDashboardState()
  if (loading) return null
  if (repos.length === 0) return <EmptyState />
  return <DashboardContent />
}

export function DashboardPage() {
  return (
    <DashboardStateProvider>
      <DashboardGate />
    </DashboardStateProvider>
  )
}

// No flex gap on the root — the spacing-1 inset lives as paddingTop inside the
// animated motion.div so it clips with height:0 on exit. Adding gap here causes
// a phantom row during collapse. Mirrors SidebarFolder.
const collapsibleRootStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
}

const expandedContentStyle: CSSProperties = {
  paddingTop: "var(--spacing-1)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--spacing-1)",
}

function DashboardContent() {
  const {
    workspaces,
    filteredRepos,
    expandedRepoId,
    expandedExpanderIds,
    toggleExpanded,
    toggleExpander,
  } = useDashboardState()

  return (
    <div
      style={{
        maxWidth: 880,
        marginInline: "auto",
        paddingBlockStart: "var(--spacing-14)",
        paddingBlockEnd: "var(--spacing-14)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--spacing-7)",
      }}
    >
      <Greeting />
      <DashboardListHeader
        title="All repos"
        count={filteredRepos.length}
        showFilters
      />
      <RecentRepos />
      <ListContainer>
        {filteredRepos.map((repo) => {
          const expanded = expandedRepoId === repo.id
          // Real owning workspace + repo NAME for routing (replaces demo
          // workspaceForRepo / DEMO_REPOS lookup). Both come from the same
          // RLS-scoped state fetch, so a connected repo always resolves.
          const workspace = workspaces.find((w) => w.id === repo.workspaceId)
          const repoName = repo.orgRepo.split("/")[1]
          const pinnedBranches = repo.branches.filter((b) => b.pinned)
          const unpinnedCount = Math.max(
            0,
            repo.totalBranches - pinnedBranches.length,
          )
          const expanderOpen = expandedExpanderIds.has(repo.id)
          // Active surface logic: when a repo is expanded, that repo row is the
          // active (bg-elevated) surface UNLESS its OtherBranchesExpander is
          // also open — in that case the expander becomes active and the parent
          // repo row dims. Any non-active row dims while another is active.
          const someRepoOpen = expandedRepoId !== null
          const expanderActive = expanded && expanderOpen
          const dimmed = someRepoOpen && (!expanded || expanderActive)
          return (
            <Collapsible.Root
              key={repo.id}
              open={expanded}
              onOpenChange={() => undefined}
              style={collapsibleRootStyle}
            >
              <Collapsible.Trigger asChild>
                <RepoRow
                  repo={repo}
                  workspace={workspace}
                  expanded={expanded}
                  dimmed={dimmed}
                  onToggleExpanded={toggleExpanded}
                />
              </Collapsible.Trigger>
              <AnimatePresence initial={false}>
                {expanded ? (
                  <Collapsible.Content forceMount asChild>
                    <motion.div
                      key={`${repo.id}-expanded`}
                      initial={{ opacity: 0, height: 0, y: 20 }}
                      animate={{ opacity: 1, height: "auto", y: 0 }}
                      exit={{ opacity: 0, height: 0, y: 20 }}
                      transition={ROW_SPRING}
                      style={{ overflow: "hidden" }}
                    >
                      <div style={expandedContentStyle}>
                        {workspace ? (
                          <BranchHoverStack
                            branches={pinnedBranches}
                            workspace={workspace}
                            repoName={repoName}
                          />
                        ) : null}
                        {unpinnedCount > 0 ? (
                          <OtherBranchesExpander
                            totalUnpinned={unpinnedCount}
                            expanded={expanderOpen}
                            onToggle={() => toggleExpander(repo.id)}
                          />
                        ) : null}
                        {/* Inner reveal: y:20 deliberately dropped at this nested
                            level. The outer keeps y:20 (mirrors sidebar's depth-1
                            reveal); compounding the translation at depth-2 would
                            double-slide ~40px during simultaneous collapse. */}
                        <Collapsible.Root
                          open={expanderOpen}
                          onOpenChange={() => undefined}
                        >
                          <AnimatePresence initial={false}>
                            {expanderOpen && workspace ? (
                              <Collapsible.Content forceMount asChild>
                                <motion.div
                                  key={`${repo.id}-unpinned`}
                                  initial={{ opacity: 0, height: 0 }}
                                  animate={{ opacity: 1, height: "auto" }}
                                  exit={{ opacity: 0, height: 0 }}
                                  transition={ROW_SPRING}
                                  style={{ overflow: "hidden" }}
                                >
                                  <BranchHoverStack
                                    branches={synthesizeUnpinnedBranches(repo, unpinnedCount)}
                                    workspace={workspace}
                                    repoName={repoName}
                                  />
                                </motion.div>
                              </Collapsible.Content>
                            ) : null}
                          </AnimatePresence>
                        </Collapsible.Root>
                      </div>
                    </motion.div>
                  </Collapsible.Content>
                ) : null}
              </AnimatePresence>
            </Collapsible.Root>
          )
        })}
      </ListContainer>
    </div>
  )
}

interface BranchHoverStackProps {
  branches: Branch[]
  // Threaded to each BranchRow so its instance link uses the real workspace +
  // repo NAME (not the repo UUID). All branches in one stack share a parent repo.
  workspace: Workspace
  repoName: string
}

interface PillBounds {
  top: number
  height: number
}

// Shared hover pill that travels between rows — mirrors SidebarHighlightLayer.
// Used by both pinned branches and the OtherBranchesExpander reveal.
function BranchHoverStack({ branches, workspace, repoName }: BranchHoverStackProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const refs = useRef<Map<string, HTMLElement>>(new Map())
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [bounds, setBounds] = useState<PillBounds | null>(null)

  const registerRef = useCallback(
    (id: string, el: HTMLElement | null) => {
      const map = refs.current
      if (el) map.set(id, el)
      else map.delete(id)
    },
    [],
  )

  const handleHoverChange = useCallback(
    (id: string, hovered: boolean) => {
      setHoveredId((prev) => {
        if (hovered) return id
        return prev === id ? null : prev
      })
    },
    [],
  )

  useLayoutEffect(() => {
    if (!hoveredId || !wrapperRef.current) {
      setBounds(null)
      return
    }
    const el = refs.current.get(hoveredId)
    if (!el) {
      setBounds(null)
      return
    }
    const wrapRect = wrapperRef.current.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    setBounds({ top: elRect.top - wrapRect.top, height: elRect.height })
  }, [hoveredId])

  const pillStyle: CSSProperties = {
    position: "absolute",
    left: 0,
    right: 0,
    background: "var(--color-bg-primary)",
    borderRadius: "var(--radius-4)",
    pointerEvents: "none",
    zIndex: 0,
  }

  return (
    <div
      ref={wrapperRef}
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: "var(--spacing-1)",
      }}
    >
      <AnimatePresence initial={false}>
        {bounds ? (
          <motion.div
            key="branch-traveling-pill"
            style={pillStyle}
            initial={{ opacity: 0, top: bounds.top, height: bounds.height }}
            animate={{ opacity: 1, top: bounds.top, height: bounds.height }}
            exit={{ opacity: 0 }}
            transition={ROW_SPRING}
          />
        ) : null}
      </AnimatePresence>
      {branches.map((branch) => (
        <BranchRow
          key={branch.id}
          branch={branch}
          workspace={workspace}
          repoName={repoName}
          noHoverBackground
          onHoverChange={(h) => handleHoverChange(branch.id, h)}
          ref={(el) => registerRef(branch.id, el)}
        />
      ))}
    </div>
  )
}

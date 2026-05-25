"use client"

// PR19 — the in-app folder/component picker. Reads the connected repo's folder
// tree live from GitHub (no rebuild just to look), lets the user tick which
// folders get previewed, persists the per-instance scan-scope override, and
// kicks off a rebuild — polling build_jobs (browser Supabase RLS session) until
// it lands, then reloading so the freshly-built sidebar shows.
//
// IMPORTANT semantics: the selection REPLACES the preview scope (it does not add
// to mount.config.ts). The copy + the "currently previewing" banner say so.
//
// Styling: Dialog primitive (same as search-modal), all visuals via tokens.

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react"
import { Checkmark, ChevronDown, ChevronRight, Folder } from "@carbon/icons-react"
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/imports/shadcn/dialog"
import { createSupabaseBrowserClient } from "@/lib/supabase/client"
import {
  ApiError,
  pickerApi,
  type RepoTreeDir,
  type RepoTreeResponse,
} from "@/lib/api/client"
import { useSidebarPanel } from "@/components/live/sidebar-panel/use-sidebar-panel"

interface TreeNode extends RepoTreeDir {
  name: string
  children: TreeNode[]
}

// Fold the flat dir list (each carries its full repo-relative path) into a tree.
// Every ancestor dir is present in the list (the API counts recursively), so a
// node's parent always resolves when it isn't top-level.
function buildTree(dirs: RepoTreeDir[]): TreeNode[] {
  const byPath = new Map<string, TreeNode>()
  for (const d of dirs) {
    byPath.set(d.path, {
      ...d,
      name: d.path.split("/").pop() ?? d.path,
      children: [],
    })
  }
  const roots: TreeNode[] = []
  for (const node of byPath.values()) {
    const parentPath = node.path.split("/").slice(0, -1).join("/")
    const parent = parentPath ? byPath.get(parentPath) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  const sortRec = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name))
    for (const n of nodes) sortRec(n.children)
  }
  sortRec(roots)
  return roots
}

// True when a STRICT ancestor of `path` is explicitly selected — i.e. a parent
// folder already covers this one (the scan is recursive), so its own checkbox
// is shown checked-and-disabled ("included via …").
function hasSelectedAncestor(path: string, selected: Set<string>): boolean {
  const segs = path.split("/")
  for (let i = 1; i < segs.length; i++) {
    if (selected.has(segs.slice(0, i).join("/"))) return true
  }
  return false
}

type SaveState = "idle" | "saving" | "rebuilding" | "build-error"

const contentStyle: CSSProperties = {
  width: "min(560px, calc(100vw - 32px))",
  boxShadow: "var(--shadow-layered)",
}

const scrollStyle: CSSProperties = {
  overflowY: "auto",
  maxHeight: "min(52vh, 420px)",
  minHeight: 160,
  paddingInline: "var(--spacing-3)",
  paddingBlock: "var(--spacing-2)",
}

export function FolderPickerModal({ instanceId }: { instanceId?: string }) {
  const { pickerOpen, actions } = useSidebarPanel()

  const [tree, setTree] = useState<RepoTreeResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [saveState, setSaveState] = useState<SaveState>("idle")
  const [buildError, setBuildError] = useState<string | null>(null)

  // Fetch the repo tree on open; reset everything on close.
  useEffect(() => {
    if (!pickerOpen) {
      setTree(null)
      setLoadError(null)
      setSelected(new Set())
      setExpanded(new Set())
      setSaveState("idle")
      setBuildError(null)
      return
    }
    if (!instanceId) {
      setLoadError("No instance to configure yet — open a synced repo first.")
      return
    }
    let active = true
    setTree(null)
    setLoadError(null)
    void (async () => {
      try {
        const data = await pickerApi.repoTree(instanceId)
        if (!active) return
        setTree(data)
        // Seed from the active override, else the current default scan, so the
        // user starts from "what's previewing now" and adds/removes.
        const seed =
          data.selectedDirs ?? (data.defaultScan ? [data.defaultScan] : [])
        setSelected(new Set(seed))
        setExpanded(new Set(data.dirs.map((d) => d.path)))
      } catch (e) {
        if (!active) return
        setLoadError(
          e instanceof ApiError
            ? e.message
            : "Couldn't read the repo folders from GitHub.",
        )
      }
    })()
    return () => {
      active = false
    }
  }, [pickerOpen, instanceId])

  // While rebuilding, poll the latest build_jobs row (RLS lets a member read it).
  // build_jobs is the reliable terminal signal — the worker only flips
  // instances.build_status to 'succeeded', never 'failed'. On success reload so
  // the server re-renders the new sidebar; on failure surface the error.
  useEffect(() => {
    if (saveState !== "rebuilding" || !instanceId) return
    const supabase = createSupabaseBrowserClient()
    let active = true
    const tick = async () => {
      const { data } = await supabase
        .from("build_jobs")
        .select("status, error, created_at")
        .eq("instance_id", instanceId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      if (!active || !data) return
      if (data.status === "succeeded") {
        window.location.reload()
      } else if (data.status === "failed" || data.status === "canceled") {
        setBuildError((data.error as string | null) || "The build failed.")
        setSaveState("build-error")
      }
    }
    void tick()
    const iv = setInterval(() => void tick(), 2500)
    return () => {
      active = false
      clearInterval(iv)
    }
  }, [saveState, instanceId])

  const roots = useMemo(() => (tree ? buildTree(tree.dirs) : []), [tree])

  const toggleSelected = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        // A parent now covers any selected descendants — drop them to keep the
        // set minimal (the worker dedups regardless).
        for (const p of [...next]) {
          if (p === path || p.startsWith(`${path}/`)) next.delete(p)
        }
        next.add(path)
      }
      return next
    })
  }, [])

  const toggleExpanded = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const handleSave = useCallback(async () => {
    if (!instanceId) return
    setSaveState("saving")
    setBuildError(null)
    const dirs = [...selected]
    try {
      await pickerApi.setPreviewDirs(instanceId, dirs.length > 0 ? dirs : null)
      setSaveState("rebuilding")
    } catch (e) {
      setBuildError(
        e instanceof ApiError ? e.message : "Couldn't save the selection.",
      )
      setSaveState("build-error")
    }
  }, [instanceId, selected])

  const busy = saveState === "saving" || saveState === "rebuilding"

  const handleOpenChange = (next: boolean) => {
    if (busy) return // don't let the user close mid-rebuild
    if (!next) actions.closePicker()
  }

  const selectedCount = selected.size

  return (
    <Dialog open={pickerOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="max-w-[calc(100vw-32px)] gap-0 p-0 overflow-hidden rounded-[var(--radius-4)] border-[var(--color-border-primary)] bg-[var(--color-bg-elevated)] sm:max-w-none"
        style={contentStyle}
      >
        {/* Header */}
        <div
          style={{
            padding: "var(--spacing-5) var(--spacing-5) var(--spacing-4)",
            borderBottom: "1px solid var(--color-border-primary)",
          }}
        >
          <DialogTitle
            className="type-6 text-trim"
            style={{
              color: "var(--color-text-primary)",
              margin: 0,
              fontWeight: "inherit",
            }}
          >
            Choose folders to preview
          </DialogTitle>
          <p
            className="type-3 text-trim"
            style={{
              color: "var(--color-text-secondary)",
              margin: 0,
              marginTop: "var(--spacing-2)",
            }}
          >
            Tick the folders to show in this preview. The selection{" "}
            <strong style={{ color: "var(--color-text-primary)" }}>
              replaces
            </strong>{" "}
            the current scope and overrides <code>mount.config.ts</code>.
          </p>
          <CurrentScope tree={tree} />
        </div>

        {/* Body */}
        <div style={scrollStyle}>
          {loadError ? (
            <StatusText tone="error">{loadError}</StatusText>
          ) : !tree ? (
            <StatusText tone="muted">
              <span className="icon-spin" style={{ display: "inline-flex" }}>
                <ChevronDown size={14} />
              </span>
              Reading your repo…
            </StatusText>
          ) : roots.length === 0 ? (
            <StatusText tone="muted">
              No folders with components found in this repo.
            </StatusText>
          ) : (
            <div role="tree" aria-label="Repo folders">
              {roots.map((node) => (
                <PickerRow
                  key={node.path}
                  node={node}
                  depth={0}
                  selected={selected}
                  expanded={expanded}
                  onToggleSelected={toggleSelected}
                  onToggleExpanded={toggleExpanded}
                />
              ))}
            </div>
          )}
          {tree?.truncated ? (
            <StatusText tone="muted">
              This repo is large — some deeply-nested folders may be omitted.
            </StatusText>
          ) : null}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "var(--spacing-4) var(--spacing-5)",
            borderTop: "1px solid var(--color-border-primary)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "var(--spacing-4)",
          }}
        >
          <span
            className="type-3 text-trim"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {saveState === "rebuilding"
              ? "Rebuilding — the sidebar refreshes when it's done."
              : buildError
                ? ""
                : `${selectedCount} folder${selectedCount === 1 ? "" : "s"} selected`}
          </span>
          <div style={{ display: "flex", gap: "var(--spacing-2)" }}>
            <button
              type="button"
              onClick={() => actions.closePicker()}
              disabled={busy}
              className="type-4 text-trim"
              style={secondaryBtn(busy)}
            >
              {saveState === "build-error" ? "Close" : "Cancel"}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={busy || !tree || !!loadError}
              className="type-4 text-trim"
              style={primaryBtn(busy || !tree || !!loadError)}
            >
              {saveState === "saving"
                ? "Saving…"
                : saveState === "rebuilding"
                  ? "Rebuilding…"
                  : "Save & rebuild"}
            </button>
          </div>
        </div>
        {buildError ? (
          <div
            className="type-3 text-trim"
            style={{
              padding: "0 var(--spacing-5) var(--spacing-4)",
              color: "var(--color-text-secondary)",
              wordBreak: "break-word",
            }}
          >
            {buildError}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

// "Currently previewing" line so the user understands what the selection
// replaces. Shows the active override, else the mount.config/auto-detect dir.
function CurrentScope({ tree }: { tree: RepoTreeResponse | null }) {
  if (!tree) return null
  const current =
    tree.selectedDirs && tree.selectedDirs.length > 0
      ? tree.selectedDirs.join(", ")
      : tree.defaultScan
        ? `${tree.defaultScan} (from mount.config.ts / auto-detect)`
        : "auto-detect"
  return (
    <p
      className="type-3 text-trim"
      style={{
        color: "var(--color-text-tertiary)",
        margin: 0,
        marginTop: "var(--spacing-2)",
      }}
    >
      Currently previewing: {current}
    </p>
  )
}

function StatusText({
  tone,
  children,
}: {
  tone: "muted" | "error"
  children: React.ReactNode
}) {
  return (
    <div
      className="type-4 text-trim"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--spacing-2)",
        padding: "var(--spacing-4) var(--spacing-2)",
        color:
          tone === "error"
            ? "var(--color-text-secondary)"
            : "var(--color-text-tertiary)",
      }}
    >
      {children}
    </div>
  )
}

interface PickerRowProps {
  node: TreeNode
  depth: number
  selected: Set<string>
  expanded: Set<string>
  onToggleSelected: (path: string) => void
  onToggleExpanded: (path: string) => void
}

function PickerRow({
  node,
  depth,
  selected,
  expanded,
  onToggleSelected,
  onToggleExpanded,
}: PickerRowProps) {
  const isOpen = expanded.has(node.path)
  const hasChildren = node.children.length > 0
  const includedByParent = hasSelectedAncestor(node.path, selected)
  const checked = includedByParent || selected.has(node.path)
  const [hovered, setHovered] = useState(false)

  const rowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "var(--spacing-2)",
    paddingBlock: "var(--spacing-2)",
    paddingInline: "var(--spacing-2)",
    paddingLeft: `calc(var(--spacing-2) + ${depth} * var(--spacing-5))`,
    borderRadius: "var(--radius-2)",
    cursor: includedByParent ? "default" : "pointer",
    background: hovered && !includedByParent ? "var(--color-bg-hover)" : "transparent",
    userSelect: "none",
  }

  return (
    <>
      <div
        role="treeitem"
        aria-selected={checked}
        aria-expanded={hasChildren ? isOpen : undefined}
        style={rowStyle}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={() => {
          if (!includedByParent) onToggleSelected(node.path)
        }}
      >
        {/* expand/collapse */}
        <button
          type="button"
          aria-label={isOpen ? "Collapse" : "Expand"}
          onClick={(e) => {
            e.stopPropagation()
            if (hasChildren) onToggleExpanded(node.path)
          }}
          style={{
            display: "inline-flex",
            width: 16,
            height: 16,
            alignItems: "center",
            justifyContent: "center",
            color: "var(--color-text-tertiary)",
            visibility: hasChildren ? "visible" : "hidden",
            background: "none",
            border: 0,
            padding: 0,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>

        {/* checkbox */}
        <span
          aria-hidden
          style={{
            display: "inline-flex",
            width: 16,
            height: 16,
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            borderRadius: "var(--radius-1)",
            border: checked
              ? "1px solid var(--color-accent)"
              : "1px solid var(--color-border-secondary)",
            background: checked ? "var(--color-accent)" : "transparent",
            opacity: includedByParent ? 0.55 : 1,
          }}
        >
          {checked ? (
            <Checkmark size={12} style={{ color: "var(--color-accent-foreground)" }} />
          ) : null}
        </span>

        <Folder
          size={16}
          style={{ color: "var(--color-text-secondary)", flexShrink: 0 }}
        />
        <span
          className="type-4 text-trim"
          style={{
            color: includedByParent
              ? "var(--color-text-tertiary)"
              : "var(--color-text-primary)",
            flex: 1,
            minWidth: 0,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {node.name}
        </span>
        <span
          className="type-3 text-trim"
          style={{ color: "var(--color-text-tertiary)", flexShrink: 0 }}
        >
          {node.totalCount}
        </span>
      </div>
      {hasChildren && isOpen
        ? node.children.map((child) => (
            <PickerRow
              key={child.path}
              node={child}
              depth={depth + 1}
              selected={selected}
              expanded={expanded}
              onToggleSelected={onToggleSelected}
              onToggleExpanded={onToggleExpanded}
            />
          ))
        : null}
    </>
  )
}

function primaryBtn(disabled: boolean): CSSProperties {
  return {
    paddingBlock: "var(--spacing-2)",
    paddingInline: "var(--spacing-4)",
    borderRadius: "var(--radius-2)",
    border: "1px solid transparent",
    background: "var(--color-primary)",
    color: "var(--color-primary-foreground)",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.5 : 1,
  }
}

function secondaryBtn(disabled: boolean): CSSProperties {
  return {
    paddingBlock: "var(--spacing-2)",
    paddingInline: "var(--spacing-4)",
    borderRadius: "var(--radius-2)",
    border: "1px solid var(--color-border-primary)",
    background: "transparent",
    color: "var(--color-text-secondary)",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.5 : 1,
  }
}

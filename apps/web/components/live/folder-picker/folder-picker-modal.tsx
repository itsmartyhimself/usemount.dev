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
  useRef,
  useState,
  type CSSProperties,
} from "react"
import { Checkmark, ChevronDown, ChevronRight, Folder } from "@carbon/icons-react"
import type { Transition } from "framer-motion"
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
import { useToast } from "@/components/live/toast"
import { ProgressBar } from "@/components/live/progress/progress-bar"

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

// "saving" = the PATCH that persists the scope + enqueues the build is in
// flight. Once it lands, the build SESSION (below) takes over.
type SaveState = "idle" | "saving"

// Build session phases. `queued`→`building`→`finishing`/`overrun` track a live
// rebuild; `succeeded`/`failed` are terminal. The session is independent of the
// modal being open — closing the modal mid-build detaches the UI but the
// session keeps tracking so the sidebar still reseeds and the trigger shows a
// "Building…" pill.
type BuildPhase =
  | "queued"
  | "building"
  | "finishing"
  | "overrun"
  | "succeeded"
  | "failed"

const BUILD_ACTIVE_PHASES: ReadonlySet<BuildPhase> = new Set([
  "queued",
  "building",
  "finishing",
  "overrun",
])

// Fallback when an instance has no prior successful build to estimate from.
const DEFAULT_ESTIMATE_MS = 45_000
// The running bar glides toward this ceiling over the estimated build time and
// holds here until the real terminal status snaps it to 100 — so it never
// claims "done" before the build actually is.
const RUNNING_CEILING = 92
const POLL_INTERVAL_MS = 2_000
// How long to hold the full bar so the user sees 100% before the modal closes.
const SETTLE_MS = 700

const PHASE_LABEL: Record<BuildPhase, string> = {
  queued: "Queued…",
  building: "Rebuilding…",
  finishing: "Finishing up…",
  overrun: "Taking longer than usual…",
  succeeded: "Done",
  failed: "Build failed",
}

const contentStyle: CSSProperties = {
  width: "min(560px, calc(100vw - 32px))",
  boxShadow: "var(--shadow-layered)",
}

const scrollStyle: CSSProperties = {
  overflowY: "auto",
  maxHeight: "min(52vh, 420px)",
  minHeight: 160,
  // spacing-2 here + each row's spacing-3 paddingInline lines the row text up
  // with the spacing-5 header/footer gutters (no doubled inset).
  paddingInline: "var(--spacing-2)",
  paddingBlock: "var(--spacing-2)",
}

export function FolderPickerModal({ instanceId }: { instanceId?: string }) {
  const { pickerOpen, actions } = useSidebarPanel()
  const { showToast } = useToast()

  const [tree, setTree] = useState<RepoTreeResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [saveState, setSaveState] = useState<SaveState>("idle")

  // Build session — survives a modal close (detach). `buildPhase` is only
  // meaningful while a session is live (terminal phases linger to show the
  // result/error). `progress`/`progressTransition` drive the bar.
  const [buildPhase, setBuildPhase] = useState<BuildPhase | null>(null)
  const [progress, setProgress] = useState(0)
  const [progressTransition, setProgressTransition] = useState<
    Transition | undefined
  >(undefined)
  const [buildError, setBuildError] = useState<string | null>(null)

  const buildActive = buildPhase !== null && BUILD_ACTIVE_PHASES.has(buildPhase)

  // Estimate (last successful build's duration), whether the running bar has
  // started its time-glide, terminal latch, and the freshest pickerOpen — all
  // in refs so the poll closure stays stable across renders.
  const estimateRef = useRef(DEFAULT_ESTIMATE_MS)
  const glideStartedRef = useRef(false)
  const terminalRef = useRef(false)
  const pickerOpenRef = useRef(pickerOpen)
  pickerOpenRef.current = pickerOpen
  const buildActiveRef = useRef(buildActive)
  buildActiveRef.current = buildActive

  // Fetch the repo tree on open; reset the VIEW on close. The build session is
  // NOT reset here when it's still active (detach keeps it tracking); a TERMINAL
  // session is cleared so a stale result/error doesn't reappear on reopen.
  useEffect(() => {
    if (!pickerOpen) {
      setTree(null)
      setLoadError(null)
      setSelected(new Set())
      setExpanded(new Set())
      setSaveState("idle")
      if (!buildActiveRef.current) {
        setBuildPhase(null)
        setBuildError(null)
      }
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

  // Poll build_jobs while a session is live. build_jobs is the authoritative
  // terminal signal (the worker only flips instances.build_status to
  // 'succeeded', never 'failed'). The running bar glides toward RUNNING_CEILING
  // over the estimated duration and snaps to 100 on success; success reseeds
  // the sidebar in place (no full-page reload). Keyed on buildActive so it
  // keeps running after a detach (modal closed) until the build resolves.
  useEffect(() => {
    if (!buildActive || !instanceId) return
    const supabase = createSupabaseBrowserClient()
    let active = true

    const finishSuccess = () => {
      if (terminalRef.current) return
      terminalRef.current = true
      setBuildPhase("succeeded")
      setProgress(100)
      setProgressTransition({ type: "spring", stiffness: 200, damping: 28 })
      window.setTimeout(() => {
        void actions.reseed().finally(() => {
          actions.setBuilding(false)
          glideStartedRef.current = false
          setBuildPhase(null)
          if (pickerOpenRef.current) actions.closePicker()
        })
      }, SETTLE_MS)
    }

    const finishFailure = (message: string | null) => {
      if (terminalRef.current) return
      terminalRef.current = true
      glideStartedRef.current = false
      actions.setBuilding(false)
      setBuildError(message || "The build failed.")
      setBuildPhase("failed")
      // Detached (modal closed) → the inline error isn't visible; toast it.
      if (!pickerOpenRef.current) {
        showToast({ tone: "error", title: message || "Rebuild failed" })
      }
    }

    const tick = async () => {
      if (terminalRef.current) return
      const { data } = await supabase
        .from("build_jobs")
        .select("status, error, started_at, created_at")
        .eq("instance_id", instanceId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      if (!active || !data) return
      if (data.status === "succeeded") return finishSuccess()
      if (data.status === "failed" || data.status === "canceled") {
        return finishFailure((data.error as string | null) ?? null)
      }
      if (data.status === "running") {
        const startedAt = data.started_at
          ? new Date(data.started_at as string).getTime()
          : Date.now()
        const elapsed = Math.max(0, Date.now() - startedAt)
        const est = estimateRef.current
        // Start the time-glide once: animate to the ceiling over the remaining
        // estimated time. Later renders don't restart it (value stays put).
        if (!glideStartedRef.current) {
          glideStartedRef.current = true
          const remaining = Math.max(2_000, est - elapsed)
          setProgress(RUNNING_CEILING)
          setProgressTransition({ duration: remaining / 1000, ease: "linear" })
        }
        setBuildPhase(
          elapsed > est
            ? "overrun"
            : elapsed > est * 0.8
              ? "finishing"
              : "building",
        )
      } else {
        setBuildPhase("queued")
      }
    }

    void tick()
    const iv = setInterval(() => void tick(), POLL_INTERVAL_MS)
    return () => {
      active = false
      clearInterval(iv)
    }
  }, [buildActive, instanceId, actions, showToast])

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
      const res = await pickerApi.setPreviewDirs(
        instanceId,
        dirs.length > 0 ? dirs : null,
      )
      setSaveState("idle")
      if (res.status === "deduped") {
        // Scope unchanged / commit already built — nothing to rebuild.
        actions.closePicker()
        return
      }
      // Begin a fresh build session.
      terminalRef.current = false
      glideStartedRef.current = false
      estimateRef.current = DEFAULT_ESTIMATE_MS
      setBuildError(null)
      setProgress(6)
      setProgressTransition({ duration: 0.4, ease: "easeOut" })
      setBuildPhase("queued")
      actions.setBuilding(true)
      // Refine the estimate from this instance's last successful build.
      void (async () => {
        const supabase = createSupabaseBrowserClient()
        const { data } = await supabase
          .from("build_jobs")
          .select("build_duration_ms")
          .eq("instance_id", instanceId)
          .eq("status", "succeeded")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle()
        const ms = data?.build_duration_ms as number | null | undefined
        if (ms && ms > 0) estimateRef.current = ms
      })()
    } catch (e) {
      setSaveState("idle")
      setBuildError(
        e instanceof ApiError ? e.message : "Couldn't save the selection.",
      )
      setBuildPhase("failed")
    }
  }, [instanceId, selected, actions])

  const saving = saveState === "saving"

  // Closing any time is allowed — closing mid-build DETACHES: the build keeps
  // running, the sidebar reseeds when it lands, and the trigger shows a pill.
  const handleOpenChange = (next: boolean) => {
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
        {/* Header — flex column with a real gap. Margins between .text-trim
            elements get eaten by the cap-height trim's negative pseudo-margins,
            so a flex gap is the only reliable vertical rhythm here. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--spacing-2)",
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
            style={{ color: "var(--color-text-secondary)", margin: 0 }}
          >
            Tick the folders to show in this preview. The selection{" "}
            <strong style={{ color: "var(--color-text-primary)" }}>
              replaces
            </strong>{" "}
            the current scope and overrides <code>mount.config.ts</code>.
          </p>
        </div>

        <div
          style={{
            ...scrollStyle,
            ...(buildActive
              ? { opacity: 0.5, pointerEvents: "none" as const }
              : null),
          }}
        >
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

        <div
          style={{
            padding: "var(--spacing-4) var(--spacing-5)",
            borderTop: "1px solid var(--color-border-primary)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--spacing-3)",
          }}
        >
          {buildPhase ? (
            <>
              {buildPhase !== "failed" ? (
                <ProgressBar value={progress} transition={progressTransition} />
              ) : null}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "var(--spacing-4)",
                }}
              >
                <span
                  className="type-3"
                  style={{
                    color:
                      buildPhase === "failed"
                        ? "var(--color-text-secondary)"
                        : "var(--color-text-tertiary)",
                    minWidth: 0,
                    flex: 1,
                    wordBreak: "break-word",
                  }}
                >
                  {buildPhase === "failed"
                    ? buildError || PHASE_LABEL.failed
                    : PHASE_LABEL[buildPhase]}
                </span>
                <div style={{ display: "flex", gap: "var(--spacing-2)", flexShrink: 0 }}>
                  {buildPhase === "failed" ? (
                    <>
                      <button
                        type="button"
                        onClick={() => actions.closePicker()}
                        className="type-4"
                        style={secondaryBtn(false)}
                      >
                        Close
                      </button>
                      <button
                        type="button"
                        onClick={handleSave}
                        disabled={!tree || !!loadError}
                        className="type-4"
                        style={primaryBtn(!tree || !!loadError)}
                      >
                        Try again
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => actions.closePicker()}
                      className="type-4"
                      style={secondaryBtn(false)}
                    >
                      Hide
                    </button>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div
              style={{
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
                {`${selectedCount} folder${selectedCount === 1 ? "" : "s"} selected`}
              </span>
              <div style={{ display: "flex", gap: "var(--spacing-2)" }}>
                <button
                  type="button"
                  onClick={() => actions.closePicker()}
                  disabled={saving}
                  className="type-4"
                  style={secondaryBtn(saving)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving || !tree || !!loadError}
                  className="type-4"
                  style={primaryBtn(saving || !tree || !!loadError)}
                >
                  {saving ? "Saving…" : "Save & rebuild"}
                </button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
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

  // Mirrors the size-32 sidebar Row exactly (row.config.ts ROW_DIMENSIONS[32]):
  // fixed 32px height, spacing-3 horizontal + gap, radius-2 — so a tree row
  // reads identically to the component rows in the sidebar. Height drives the
  // vertical rhythm; paddingBlock is nominal (border-box, like Row).
  const rowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "var(--spacing-3)",
    height: 32,
    boxSizing: "border-box",
    paddingBlock: "var(--spacing-2-5)",
    paddingRight: "var(--spacing-3)",
    paddingLeft: `calc(var(--spacing-3) + ${depth} * var(--spacing-5))`,
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
            // The design's real high-contrast selection is a solid text-primary
            // fill (every active Row uses it) — NOT --color-accent, which is a
            // faint hover-grey and read as a mushy checkbox.
            border: checked
              ? "1px solid var(--color-text-primary)"
              : "1px solid var(--color-border-secondary)",
            background: checked ? "var(--color-text-primary)" : "transparent",
            opacity: includedByParent ? 0.55 : 1,
          }}
        >
          {checked ? (
            <Checkmark size={12} style={{ color: "var(--color-bg-primary)" }} />
          ) : null}
        </span>

        <Folder
          size={16}
          style={{ color: "var(--color-text-secondary)", flexShrink: 0 }}
        />
        <span
          // No .text-trim: the cap-height trim's pseudo-margins get clipped by
          // overflow:hidden and crop folder-name glyphs. Row labels truncate
          // with plain type-4 + ellipsis — match that.
          className="type-4"
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
          className="type-3"
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

// Mirror the design system's smallest Button (button.config.ts size="small"):
// 36px tall, radius-3, spacing-6 horizontal padding, spacing-3 gap. Height
// drives the vertical breathing room (zero explicit vertical padding) exactly
// like Button — colors are unchanged, only the cramped sizing is fixed.
const btnBase: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "var(--spacing-3)",
  height: 36,
  boxSizing: "border-box",
  paddingBlock: 0,
  paddingInline: "var(--spacing-6)",
  borderRadius: "var(--radius-3)",
  borderWidth: 1,
  borderStyle: "solid",
}

function primaryBtn(disabled: boolean): CSSProperties {
  return {
    ...btnBase,
    borderColor: "transparent",
    background: "var(--color-primary)",
    color: "var(--color-primary-foreground)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.4 : 1,
  }
}

function secondaryBtn(disabled: boolean): CSSProperties {
  return {
    ...btnBase,
    borderColor: "var(--color-border-primary)",
    background: "transparent",
    color: "var(--color-text-secondary)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.4 : 1,
  }
}

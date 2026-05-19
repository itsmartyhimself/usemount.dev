import { Canvas } from "./canvas"
import { CanvasViewProvider } from "./canvas-view-context"
import { StaleViewerTrigger } from "./stale-viewer-trigger"
import { DocModal } from "@/components/live/doc-modal"
import {
  SidebarPanel,
  SidebarPanelProvider,
} from "@/components/live/sidebar-panel"
import { ToastProvider } from "@/components/live/toast"

export interface AppShellInstance {
  workspace: string
  repo: string
  branch: string
  // Resolved server-side from the route slugs (PR3 / migration-plan Step 3).
  // Optional + additive so /playground and slug-only callers still type-check.
  // The component tree / registry that would consume these stays mock until
  // Step 4.3 — this is the fetch seam, not its consumer.
  instanceId?: string
  repoConnectionId?: string
  manifestCount?: number
}

export interface AppShellProps {
  /**
   * Route-derived instance identity from `/[workspace]/[repo]/[branch]`.
   * Optional: other callers (e.g. /playground) mount AppShell with no instance
   * and must keep working. Threaded for migration-plan Step 3 — no fetch yet,
   * rendering is identical whether or not this is provided.
   */
  instance?: AppShellInstance
}

export function AppShell({ instance }: AppShellProps = {}) {
  if (process.env.NODE_ENV !== "production")
    console.debug("[AppShell] instance", instance)
  return (
    <ToastProvider>
      <CanvasViewProvider>
        <SidebarPanelProvider>
          <main
            className="flex"
            style={{
              height: "100dvh",
              padding: "var(--spacing-4)",
              gap: "var(--spacing-4)",
              background: "var(--color-bg-primary)",
            }}
          >
            <SidebarPanel />
            <Canvas />
          </main>
          <DocModal />
          <StaleViewerTrigger />
        </SidebarPanelProvider>
      </CanvasViewProvider>
    </ToastProvider>
  )
}

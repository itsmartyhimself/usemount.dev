import type { ComponentManifest } from "@usemount/shared"
import type { Registry } from "@/lib/registry/types"
import { Canvas } from "./canvas"
import { CanvasViewProvider } from "./canvas-view-context"
import { StaleViewerTrigger } from "./stale-viewer-trigger"
import { DocModal } from "@/components/live/doc-modal"
import { FolderPickerModal } from "@/components/live/folder-picker"
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
  instanceId?: string
  repoConnectionId?: string
  manifestCount?: number
  /**
   * `instances.last_synced_commit_sha` at page-load time — PR8 (Step 4.4)
   * baseline for the Realtime stale-viewer subscription. `null` means
   * "no successful build yet"; the first sha that arrives will trigger
   * the stale-viewer toast.
   */
  lastSyncedCommitSha?: string | null
}

export interface AppShellProps {
  /**
   * Route-derived instance identity from `/[workspace]/[repo]/[branch]`.
   * Optional: other callers (e.g. /playground) mount AppShell with no instance
   * and must keep working.
   */
  instance?: AppShellInstance
  /**
   * Pre-fetched sidebar registry. PR7 fetches it server-side from
   * `component_manifests` rows for the instance. Optional — defaults to an
   * empty registry so legacy callers without instance context still render.
   */
  initialRegistry?: Registry
  /**
   * Pre-fetched manifest map keyed by leaf id (= component_manifests.id).
   * PR7 consumes it through SidebarPanelProvider → canvas-controls-context.
   */
  initialManifests?: Map<string, ComponentManifest>
}

export function AppShell({
  instance,
  initialRegistry,
  initialManifests,
}: AppShellProps = {}) {
  if (process.env.NODE_ENV !== "production")
    console.debug("[AppShell] instance", instance, {
      manifests: initialManifests?.size ?? 0,
    })
  return (
    <ToastProvider>
      <CanvasViewProvider>
        <SidebarPanelProvider
          initialRegistry={initialRegistry}
          initialManifests={initialManifests}
        >
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
          <FolderPickerModal instanceId={instance?.instanceId} />
          <StaleViewerTrigger
            instanceId={instance?.instanceId}
            initialSha={instance?.lastSyncedCommitSha}
          />
        </SidebarPanelProvider>
      </CanvasViewProvider>
    </ToastProvider>
  )
}

"use client"

import { WorkspaceCard } from "@/components/live/workspace-card"
import type { Workspace } from "@/lib/dashboard/types"

interface StepAssignWorkspaceProps {
  workspaces: Workspace[]
  value: string
  onChange: (id: string) => void
}

export function StepAssignWorkspace({
  workspaces,
  value,
  onChange,
}: StepAssignWorkspaceProps) {
  // Columns track the workspace count (max 2 per row, the original density) so
  // the cards fill the parent — 1 workspace spans full width, 2 split evenly,
  // 3+ wrap. Unlike the dashboard this is a picker: every workspace must stay
  // visible, so there's no hide cap.
  const columns = Math.max(1, Math.min(workspaces.length, 2))
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--spacing-3-5)",
        padding: "var(--spacing-1)",
        background: "var(--color-bg-tertiary)",
        borderRadius: "var(--radius-4-5)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "var(--spacing-3-5)",
        }}
      >
        <span
          className="type-4"
          style={{ color: "var(--color-text-tertiary)", lineHeight: 1 }}
        >
          Assign to workspace
        </span>
      </div>
      <div
        role="radiogroup"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gap: "var(--spacing-1)",
        }}
      >
        {workspaces.map((workspace) => (
          <WorkspaceCard
            key={workspace.id}
            workspace={workspace}
            selected={workspace.id === value}
            onSelect={() => onChange(workspace.id)}
          />
        ))}
      </div>
    </div>
  )
}

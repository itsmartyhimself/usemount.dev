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
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
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

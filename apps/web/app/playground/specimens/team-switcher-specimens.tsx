"use client"

import type { Team } from "@/lib/registry/types"
import { TeamSwitcher } from "@/components/live/team-switcher"
import { Specimen, SpecimenGroup, SIDEBAR_WIDTH_SPECIMEN } from "./_shared"

// Demo team data inlined here. The shared DEMO_REGISTRY was deleted in PR7
// when the canvas + sidebar moved to real component_manifests; the
// team-switcher specimen still needs a couple of Team rows to render.
const ACME_TEAM: Team = { id: "acme", name: "Acme", plan: "Pro plan" }
const TEAMS_MULTI: Team[] = [
  ACME_TEAM,
  { id: "northwind", name: "Northwind", plan: "Starter plan" },
]

export function TeamSwitcherSpecimens() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--spacing-11)",
      }}
    >
      <SpecimenGroup title="Single team (chevron hidden)">
        <Specimen
          label={`teams=[Acme] activeTeamId="acme"`}
          width={SIDEBAR_WIDTH_SPECIMEN}
        >
          <TeamSwitcher
            teams={[ACME_TEAM]}
            activeTeamId={ACME_TEAM.id}
          />
        </Specimen>
      </SpecimenGroup>
      <SpecimenGroup title="Multi-team (chevron visible, click for stub popover)">
        <Specimen
          label={`teams=[Acme, Northwind] activeTeamId="acme"`}
          width={SIDEBAR_WIDTH_SPECIMEN}
        >
          <TeamSwitcher
            teams={TEAMS_MULTI}
            activeTeamId={ACME_TEAM.id}
          />
        </Specimen>
      </SpecimenGroup>
    </div>
  )
}

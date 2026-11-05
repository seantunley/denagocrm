"use server";

import { prisma } from "@/lib/db";
import { canAccessLead, requirePermission } from "@/lib/permissions";
import { withActingStaffScope } from "@/lib/actingScope";
import { journeyScope } from "@/lib/flowScope";
import { loadJourneyContext, journeyTemplateVars, type JourneyContext } from "@/lib/journeyContext";
import { dryRunJourney, type DryRunResult, type DryRunScenario } from "@/lib/journeyDryRun";

export type DryRunActionResult = { ok: true; result: DryRunResult; version: number; state: string } | { ok: false; error: string };

/**
 * DRY RUN — READ ONLY. Loads the version the editor shows (the draft, else the published one) and, optionally, one
 * lead's data for its conditions; then walks it in lib/journeyDryRun, which cannot send or write. No run, event,
 * step log or audit row is created: nothing here writes (tests/journeyDryRun.test.ts).
 */
export async function dryRunJourneyAction(journeyId: string, leadId: string | null, scenario: DryRunScenario): Promise<DryRunActionResult> {
  return withActingStaffScope(async () => {
    const user = await requirePermission("journeys.manage");
    const journey = await prisma.journey.findFirst({
      where: { id: journeyId, ...(await journeyScope()) },
      select: { tenantId: true, activeVersion: true, versions: { orderBy: { version: "desc" }, select: { version: true, state: true, definition: true } } },
    });
    if (!journey) return { ok: false as const, error: "Journey not found." };
    const version = journey.versions.find((v) => v.state === "draft") ?? journey.versions.find((v) => v.version === journey.activeVersion) ?? journey.versions[0];
    if (!version) return { ok: false as const, error: "This journey has no steps yet." };

    let context: Record<string, unknown> = { event: { manual: true, dryRun: true }, lead: null, contact: null };
    if (leadId) {
      // The lead must be this journey's own workspace's AND one this person may open (the same rule as the
      // page's lead picker, getAccessibleLeadIds) — checked at the door, since a crafted request skips the picker.
      const lead = await prisma.lead.findFirst({ where: { id: leadId }, select: { id: true, tenantId: true } });
      if (!lead || lead.tenantId !== journey.tenantId || !(await canAccessLead(user, lead.id))) return { ok: false as const, error: "Lead not found." };
      context = (await loadJourneyContext("lead", lead.id, { manual: true, dryRun: true })) ?? context;
    }
    try {
      const result = dryRunJourney({
        definition: version.definition,
        context,
        scenario,
        templateVars: (ctx) => journeyTemplateVars(ctx as JourneyContext),
      });
      return { ok: true as const, result, version: version.version, state: version.state };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? `The journey can't be walked: ${error.message}` : "The journey can't be walked." };
    }
  });
}

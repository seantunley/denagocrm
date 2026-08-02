import { prisma } from "./db";
import { emitJourneyEvent } from "./journeyEvents";
import { isModuleEnabled } from "./modules/enabled";
import type { JourneyEventTrigger } from "./journeyTypes";

/**
 * The one way an application write path tells the Journey engine that something
 * happened to a lead.
 *
 * This replaces `runLeadAutomations` from the retired AutomationRule engine.
 * Three engines used to answer "when X happens to a lead, send an email / make
 * an activity / move a stage"; the Journey engine is the one that survives.
 *
 * THE BUG THIS FIXES: `emitJourneyEvent` was never called from ANY write path.
 * Its only callers were the cron scheduler (lead_idle / contact_segment /
 * purchase_anniversary / win_back) and the journey engine's own move_stage
 * step. So every one of the eight EVENT triggers the builder offers — including
 * "New lead created" and "Lead enters a stage", worded identically to the
 * automations builder next to it — enrolled nobody, ever. You built the
 * journey, activated it, and nothing happened, with no error anywhere.
 *
 * ERROR ISOLATION: `runLeadAutomations` wrapped its whole body in a
 * try/catch with the comment "Automations must never break the main flow", so
 * callers could `await` it bare — an inbound lead webhook could not 500 because
 * a rule threw. Several call sites relied on exactly that and added no `.catch`
 * of their own. This function keeps that contract: it resolves, never rejects.
 */
export async function emitLeadJourneyEvent(
  trigger: JourneyEventTrigger,
  leadId: string,
  options: {
    /**
     * What makes THIS firing distinct from the next one of the same trigger on
     * the same lead. `JourneyEvent.dedupeKey` is UNIQUE and a collision is
     * swallowed as "already seen", so a key that repeats would silently drop
     * every firing after the first — a lead won, reopened and won again would
     * enrol only once.
     *
     * Defaults to the lead row's `updatedAt`, which is correct for the triggers
     * emitted immediately after writing the lead (created / stage / won / lost).
     * Pass an explicit value where the occurrence belongs to another record —
     * the quote that was signed, declined or delivered, say — because those do
     * not touch the lead row at all.
     */
    occurrence?: string;
    payload?: Record<string, unknown>;
  } = {},
): Promise<void> {
  try {
    // Same gate, same place as the engine it replaces: `runLeadAutomations`
    // gated the ENGINE rather than each of its ~10 callers, so with Marketing
    // off nothing fired and nothing was written. Gating here keeps that, and
    // stops JourneyEvent rows accumulating forever for a tenant whose cron
    // (api/cron/journeys) declines to process them for the same reason.
    if (!(await isModuleEnabled("marketing"))) return;
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: { id: true, stageId: true, updatedAt: true },
    });
    // Not found also covers "not in this tenant" — the scoped client returns
    // null under RLS — so a stray id can never enrol another tenant's lead.
    if (!lead) return;

    await emitJourneyEvent({
      type: trigger,
      entityType: "lead",
      entityId: lead.id,
      payload: {
        ...options.payload,
        // The stage AS AT the moment of the event. `triggerMatches` prefers
        // this over the lead's current stage, so a lead that moves again before
        // the 15-minute cron drains the queue still matches the stage it
        // actually entered.
        stageId: lead.stageId,
      },
      dedupeKey: `lead-event:${trigger}:${leadId}:${options.occurrence ?? lead.updatedAt.toISOString()}`,
    });
  } catch {
    // Deliberately swallowed — see ERROR ISOLATION above.
  }
}

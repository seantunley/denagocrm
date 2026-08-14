"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { logAuditStrict } from "@/lib/audit";
import { withActingStaffScope } from "@/lib/actingScope";
import { requireLeadAccess } from "@/lib/permissions";
import { SNOOZE_DAYS } from "@/lib/attention/score";

/**
 * Snooze a lead's attention signals, or wake them again.
 *
 * A signal you have already acknowledged must stop shouting, or the list stops
 * being read — and a list nobody reads is worse than no list, because it looks
 * like coverage. This is the only write the Attention Centre makes.
 *
 * ── WHY IT IS AUDITED ───────────────────────────────────────────────────────
 *
 * Snoozing is how a deal legitimately disappears from the one screen whose job is
 * to make sure nothing is forgotten. "Who silenced this, and when" is exactly the
 * question somebody asks a month later about a deal that went quiet, and the row
 * itself only remembers the deadline, not the decision.
 *
 * ── PERMISSION ──────────────────────────────────────────────────────────────
 *
 * `leads.edit`, through `requireLeadAccess`, which also enforces that this caller
 * may see THIS lead. Snoozing is not a stage change and not a status change, but
 * it is a change to how the lead is worked — a read-only viewer must not be able
 * to silence somebody else's queue.
 *
 * Bound in an enclosing `withActingStaffScope` for the reason every standalone
 * Server Action in this codebase now is: nothing renders it, so nothing above it
 * has established a workspace, and the guarded reads inside would fail closed
 * under enforcement.
 */
export async function setLeadAttentionSnooze(
  leadId: string,
  snooze: boolean,
): Promise<{ ok: boolean; error?: string }> {
  return withActingStaffScope(async () => {
    const user = await requireLeadAccess(leadId, "leads.edit");
    const before = await prisma.lead.findUnique({
      where: { id: leadId },
      select: { id: true, title: true, contactId: true, attentionSnoozedUntil: true },
    });
    if (!before) return { ok: false, error: "Lead not found." };

    const until = snooze ? new Date(Date.now() + SNOOZE_DAYS * 24 * 60 * 60 * 1000) : null;
    // The write and its audit together: a snooze nobody can account for is the
    // thing the audit exists to prevent, so it must not be able to commit alone.
    await prisma.$transaction(async (tx) => {
      await tx.lead.update({ where: { id: leadId }, data: { attentionSnoozedUntil: until } });
      await logAuditStrict(
        {
          action: snooze ? "lead.attention_snoozed" : "lead.attention_woken",
          summary: snooze
            ? `Snoozed attention on “${before.title}” for ${SNOOZE_DAYS} days`
            : `Brought “${before.title}” back into the attention list`,
          leadId,
          contactId: before.contactId,
          user,
          before: { attentionSnoozedUntil: before.attentionSnoozedUntil },
          after: { attentionSnoozedUntil: until },
        },
        tx,
      );
    });

    revalidatePath("/leads/attention");
    revalidatePath("/leads");
    return { ok: true };
  });
}

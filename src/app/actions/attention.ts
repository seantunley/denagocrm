"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { logAuditStrict } from "@/lib/audit";
import { withActingStaffScope } from "@/lib/actingScope";
import { requireLeadAccess } from "@/lib/permissions";
import { dismissReasonError } from "@/lib/attention/score";

/**
 * Dismiss a lead from the Attention Centre — WITH A REASON, always.
 *
 * ── WHY THE REASON IS NOT OPTIONAL ──────────────────────────────────────────
 *
 * This is the one screen whose job is to make sure nothing is forgotten, so the
 * only way off it must be accountable. A one-click dismiss is a button that makes
 * work disappear, and the first time somebody asks "why did nobody chase this
 * deal", the honest answer would be "someone clicked something".
 *
 * VALIDATED ON THE SERVER, not only in the dialog. The dialog's disabled button is
 * a courtesy; this is the rule. A Server Action is a public endpoint and a client
 * that skipped the form would otherwise write an empty justification — which is
 * worse than no field at all, because the audit trail would look complete.
 *
 * ── PERMISSION ──────────────────────────────────────────────────────────────
 *
 * `leads.edit`, through `requireLeadAccess`, which also enforces that this caller
 * may see THIS lead. Dismissing is not a stage or status change, but it is a
 * change to how the lead gets worked, and a read-only viewer must not be able to
 * empty somebody else's queue.
 */
export async function dismissLeadAttention(
  leadId: string,
  reason: string,
): Promise<{ ok: boolean; error?: string }> {
  return withActingStaffScope(async () => {
    const invalid = dismissReasonError(reason);
    if (invalid) return { ok: false, error: invalid };

    const user = await requireLeadAccess(leadId, "leads.edit");
    const before = await prisma.lead.findUnique({
      where: { id: leadId },
      select: { id: true, title: true, name: true, contactId: true, attentionDismissedAt: true },
    });
    if (!before) return { ok: false, error: "Lead not found." };

    const trimmed = reason.trim();
    const at = new Date();
    // The write and its audit together. A dismissal nobody can account for is the
    // exact thing the reason exists to prevent, so it must not be able to commit
    // on its own.
    await prisma.$transaction(async (tx) => {
      await tx.lead.update({
        where: { id: leadId },
        data: { attentionDismissedAt: at, attentionDismissReason: trimmed },
      });
      await logAuditStrict(
        {
          action: "lead.attention_dismissed",
          summary: `Dismissed “${before.name}” from the attention list — reason: “${trimmed}”`,
          leadId,
          contactId: before.contactId,
          user,
          before: { attentionDismissedAt: before.attentionDismissedAt },
          after: { attentionDismissedAt: at, attentionDismissReason: trimmed },
        },
        tx,
      );
    });

    revalidatePath("/leads/attention");
    revalidatePath("/leads");
    return { ok: true };
  });
}

/**
 * Put a dismissed lead back on the list.
 *
 * No reason required, and that asymmetry is deliberate: restoring ADDS work to
 * somebody's queue, which needs no justification, while dismissing removes it,
 * which does. The reason that was given is cleared with it — keeping a stale
 * justification on a live row would have it read as current the next time
 * somebody dismissed the deal without one.
 */
export async function restoreLeadAttention(leadId: string): Promise<{ ok: boolean; error?: string }> {
  return withActingStaffScope(async () => {
    const user = await requireLeadAccess(leadId, "leads.edit");
    const before = await prisma.lead.findUnique({
      where: { id: leadId },
      select: { id: true, name: true, contactId: true, attentionDismissedAt: true, attentionDismissReason: true },
    });
    if (!before) return { ok: false, error: "Lead not found." };

    await prisma.$transaction(async (tx) => {
      await tx.lead.update({
        where: { id: leadId },
        data: { attentionDismissedAt: null, attentionDismissReason: null },
      });
      await logAuditStrict(
        {
          action: "lead.attention_restored",
          summary: `Brought “${before.name}” back onto the attention list`,
          leadId,
          contactId: before.contactId,
          user,
          before: {
            attentionDismissedAt: before.attentionDismissedAt,
            attentionDismissReason: before.attentionDismissReason,
          },
          after: { attentionDismissedAt: null, attentionDismissReason: null },
        },
        tx,
      );
    });

    revalidatePath("/leads/attention");
    revalidatePath("/leads");
    return { ok: true };
  });
}

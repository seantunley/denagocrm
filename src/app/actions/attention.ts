"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { logAuditStrict } from "@/lib/audit";
import { withActingStaffScope } from "@/lib/actingScope";
import { requireLeadAccess } from "@/lib/permissions";
import { attentionReasonError, snoozeDateError } from "@/lib/attention/score";
import type { AttentionSignalKind } from "@/lib/attention/score";
import { parseAttentionDispositions } from "@/lib/attention/dispositions";

const SIGNAL_KINDS = new Set<AttentionSignalKind>([
  "unanswered_inbound", "overdue_task", "quote_expiring", "no_next_step", "stage_age",
]);

function validSignal(signalKey: string, kind: AttentionSignalKind): boolean {
  return signalKey.length > 0 && signalKey.length <= 160 && SIGNAL_KINDS.has(kind);
}

/**
 * Snooze a lead until a date — WITH A REASON, always.
 *
 * ── WHY BOTH THIS AND DISMISS EXIST ─────────────────────────────────────────
 *
 * They are different decisions. Snooze says "nothing is wrong, come back on the
 * 19th"; dismiss says "this does not belong on the list". The commonest real case
 * is the first — a customer travelling, a decision due after month-end — and
 * dismissing one of those is a lie, while leaving it shouting is what makes a
 * list stop being read.
 *
 * The reason is required here too. It is not there to justify the snooze so much
 * as to answer the question the next person has: "back from Italy on the 19th" is
 * exactly what somebody needs to see when the deal reappears.
 *
 * BOTH the date and the reason are validated on the SERVER. A Server Action is a
 * public endpoint, and a client that skipped the form would otherwise write an
 * unbounded snooze — which is a dismiss wearing a date, without the honesty.
 */
export async function snoozeLeadAttention(
  leadId: string,
  untilIso: string,
  reason: string,
  signalKey: string,
  signalKind: AttentionSignalKind,
): Promise<{ ok: boolean; error?: string }> {
  return withActingStaffScope(async () => {
    const now = new Date();
    const until = new Date(untilIso);
    const badDate = snoozeDateError(Number.isNaN(until.getTime()) ? null : until, now);
    if (badDate) return { ok: false, error: badDate };
    const badReason = attentionReasonError(reason, "snooze");
    if (badReason) return { ok: false, error: badReason };
    if (!validSignal(signalKey, signalKind)) return { ok: false, error: "That attention item is no longer valid." };

    const user = await requireLeadAccess(leadId, "leads.edit");
    const before = await prisma.lead.findUnique({
      where: { id: leadId },
      select: { id: true, name: true, contactId: true, attentionDispositions: true },
    });
    if (!before) return { ok: false, error: "Lead not found." };

    const trimmed = reason.trim();
    const dispositions = parseAttentionDispositions(before.attentionDispositions);
    const previous = dispositions[signalKey];
    const next = {
      ...dispositions,
      [signalKey]: {
        kind: signalKind,
        signalKey,
        state: "snoozed" as const,
        reason: trimmed,
        snoozedUntil: until.toISOString(),
        snoozeCount: (previous?.snoozeCount ?? 0) + 1,
        lastSnoozedAt: now.toISOString(),
      },
    };
    await prisma.$transaction(async (tx) => {
      await tx.lead.update({
        where: { id: leadId },
        data: { attentionDispositions: next },
      });
      await logAuditStrict(
        {
          action: "lead.attention_snoozed",
          summary: `Snoozed “${before.name}” until ${until.toISOString().slice(0, 10)} — reason: “${trimmed}”`,
          leadId,
          contactId: before.contactId,
          user,
          before: { attentionDisposition: previous ?? null },
          after: { attentionDisposition: next[signalKey] },
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
  signalKey: string,
  signalKind: AttentionSignalKind,
): Promise<{ ok: boolean; error?: string }> {
  return withActingStaffScope(async () => {
    const invalid = attentionReasonError(reason, "dismiss");
    if (invalid) return { ok: false, error: invalid };
    if (!validSignal(signalKey, signalKind)) return { ok: false, error: "That attention item is no longer valid." };

    const user = await requireLeadAccess(leadId, "leads.edit");
    const before = await prisma.lead.findUnique({
      where: { id: leadId },
      select: { id: true, title: true, name: true, contactId: true, attentionDispositions: true },
    });
    if (!before) return { ok: false, error: "Lead not found." };

    const trimmed = reason.trim();
    const at = new Date();
    const dispositions = parseAttentionDispositions(before.attentionDispositions);
    const previous = dispositions[signalKey];
    const next = {
      ...dispositions,
      [signalKey]: {
        kind: signalKind,
        signalKey,
        state: "dismissed" as const,
        reason: trimmed,
        dismissedAt: at.toISOString(),
        snoozeCount: previous?.snoozeCount ?? 0,
        lastSnoozedAt: previous?.lastSnoozedAt,
      },
    };
    // The write and its audit together. A dismissal nobody can account for is the
    // exact thing the reason exists to prevent, so it must not be able to commit
    // on its own.
    await prisma.$transaction(async (tx) => {
      await tx.lead.update({
        where: { id: leadId },
        data: { attentionDispositions: next },
      });
      await logAuditStrict(
        {
          action: "lead.attention_dismissed",
          summary: `Dismissed “${before.name}” from the attention list — reason: “${trimmed}”`,
          leadId,
          contactId: before.contactId,
          user,
          before: { attentionDisposition: previous ?? null },
          after: { attentionDisposition: next[signalKey] },
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
 * Put a lead back on the list, however it came off.
 *
 * ONE action for both exits. "Bring this back" is a single intent, and asking
 * somebody to notice whether a deal was snoozed or dismissed before they can
 * un-hide it would be a distinction that serves the data model rather than the
 * person reading the screen.
 *
 * No reason required, and that asymmetry is deliberate: restoring ADDS work to a
 * queue, which needs no justification, while snoozing and dismissing remove it,
 * which does. Both stored reasons are cleared with their dates — a justification
 * left behind on a live row would read as current the next time the deal was set
 * aside.
 */
export async function restoreLeadAttention(
  leadId: string,
  signalKey?: string,
): Promise<{ ok: boolean; error?: string }> {
  return withActingStaffScope(async () => {
    const user = await requireLeadAccess(leadId, "leads.edit");
    const before = await prisma.lead.findUnique({
      where: { id: leadId },
      select: {
        id: true,
        name: true,
        contactId: true,
        attentionSnoozedUntil: true,
        attentionSnoozeReason: true,
        attentionDismissedAt: true,
        attentionDismissReason: true,
        attentionDispositions: true,
      },
    });
    if (!before) return { ok: false, error: "Lead not found." };

    const dispositions = parseAttentionDispositions(before.attentionDispositions);
    if (signalKey && signalKey !== "legacy") delete dispositions[signalKey];
    await prisma.$transaction(async (tx) => {
      await tx.lead.update({
        where: { id: leadId },
        data: {
          attentionSnoozedUntil: null,
          attentionSnoozeReason: null,
          attentionDismissedAt: null,
          attentionDismissReason: null,
          attentionDispositions: dispositions,
        },
      });
      await logAuditStrict(
        {
          action: "lead.attention_restored",
          summary: `Brought “${before.name}” back onto the attention list`,
          leadId,
          contactId: before.contactId,
          user,
          before: {
            attentionSnoozedUntil: before.attentionSnoozedUntil,
            attentionSnoozeReason: before.attentionSnoozeReason,
            attentionDismissedAt: before.attentionDismissedAt,
            attentionDismissReason: before.attentionDismissReason,
          },
          after: { attentionSnoozedUntil: null, attentionDismissedAt: null },
        },
        tx,
      );
    });

    revalidatePath("/leads/attention");
    revalidatePath("/leads");
    return { ok: true };
  });
}

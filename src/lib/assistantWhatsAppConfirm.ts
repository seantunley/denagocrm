import "server-only";
import { basePrisma } from "./db";
import { getSetting } from "./settings";
import { logAudit } from "./audit";
import { logError } from "./errorLog";
import { runAsLinkedStaff } from "./auth";
import { sendWhatsAppButtons, sendWhatsAppText } from "./whatsapp";
import type { ActionCard } from "./assistantActions";
import type { PermissionUser } from "./permissions";
import { runAssistantAction } from "@/app/actions/assistant";
import {
  ASSISTANT_WHATSAPP_CONFIRM_KEY,
  CRM_CARD_TTL_MS,
  PENDING_ACTION_TTL_MS,
  WHATSAPP_CONFIRMABLE,
  CONFIRM_TITLE,
  confirmAllButtonId,
  confirmButtonId,
  confirmMessages,
  whatsappBold,
  splitForWhatsApp_cards,
  whatsappConfirmOn,
} from "./assistantWhatsAppRules";

/*
 * Confirming, from a linked phone, a task the assistant proposed there.
 *
 * Kept apart from assistantWhatsApp.ts on purpose. That file ANSWERS, and its
 * tests hold it to writing nothing. This one is the single place a WhatsApp
 * message can change a record, and it does so only by handing the stored card
 * to runAssistantAction — the same function the CRM's Confirm button calls — as
 * the person who tapped. So the permission check, the record-access check, the
 * "has this changed since?" check and the audit entry are the CRM's own.
 *
 * The caller (handleStaffWhatsApp) has already established, for THIS message:
 * the workspace, that the number is a verified link whose sign-in is still
 * valid, that it is not a customer's number, and that the person is still an
 * active member who may use the assistant. Nothing here is reached otherwise.
 */

const say = async (waId: string, text: string) => {
  const sent = await sendWhatsAppText(waId, text).catch(() => ({ ok: false }));
  if (!sent.ok) await logError("assistant-whatsapp", "confirm reply send failed").catch(() => {});
};

export async function confirmingOnWhatsAppOn(): Promise<boolean> {
  return whatsappConfirmOn(await getSetting(ASSISTANT_WHATSAPP_CONFIRM_KEY).catch(() => null));
}

/**
 * After an answer: offer each proposed task. One message per task with a Confirm
 * button, when the owner allows it and the task is an internal change; otherwise
 * one line saying it needs the CRM, so a proposal is never silently dropped.
 * A failure here costs the offer, never the answer (already sent).
 */
export async function offerConfirmations(
  tenantId: string,
  userId: string,
  waId: string,
  cards: readonly ActionCard[],
  /**
   * Tasks still waiting that JOIN this offer (voice-first: one of a set was corrected — its replacement is offered
   * here, and the rest of the set comes with it, so "Confirm all" / "yes to all" still means the whole set).
   */
  carry: readonly string[] = [],
): Promise<void> {
  if (cards.length === 0) return;
  try {
    const on = await confirmingOnWhatsAppOn();
    const { confirmable, crmOnly } = splitForWhatsApp_cards(cards);
    const elsewhere = on ? [...crmOnly] : [...cards];
    // Could have been confirmed here, but its Confirm button did not arrive.
    const unbuttoned = new Set<ActionCard>();
    // ONE OFFER, ONE createdAt: "Confirm all" / "yes to all" means exactly the tasks offered together — never an
    // older offer still waiting (confirmAllFromWhatsApp).
    const offeredAt = new Date();
    const offered: string[] = [];
    const offering = on ? confirmable : [];
    for (const [at, card] of offering.entries()) {
      // What will be shown, in full. Null: it cannot be shown whole, so it gets no button.
      const messages = confirmMessages(card);
      if (!messages) { elsewhere.push(card); continue; }
      // The full text FIRST, and every part of it delivered — only then does a
      // Confirm button exist. A button whose text did not arrive would be a
      // button for something unseen, so a failed part means no button and no row.
      let shown = true;
      for (const text of messages.before) {
        if (!(await sendWhatsAppText(waId, text)).ok) { shown = false; break; }
      }
      if (!shown) {
        await logError("assistant-whatsapp", "confirm text send failed — no button offered");
        elsewhere.push(card);
        continue;
      }
      const pending = await basePrisma.assistantPendingAction.create({
        data: { tenantId, userId, card: card as object, createdAt: offeredAt, expiresAt: new Date(Date.now() + PENDING_ACTION_TTL_MS) },
        select: { id: true },
      });
      // WhatsApp's own header and grey footer (2026-11-02, "more colourful"): which of the set, and the reminder.
      const frame = { ...(offering.length > 1 ? { header: `📋 Task ${at + 1} of ${offering.length}` } : {}), footer: messages.footer };
      const sent = await sendWhatsAppButtons(waId, messages.body, [{ id: confirmButtonId(pending.id), title: CONFIRM_TITLE }], frame);
      if (!sent.ok) {
        await logError("assistant-whatsapp", "confirm offer send failed");
        // NO BUTTON ARRIVED, so this row can never be confirmed from the phone —
        // and, not being a CRM card, it was not on the Ask page either: the task
        // was kept where nobody could reach it. It goes to the Ask page with the
        // rest. The unreachable row is removed; if that fails it simply expires.
        await basePrisma.assistantPendingAction
          .deleteMany({ where: { id: pending.id, tenantId, userId, forCrm: false, confirmedAt: null } })
          .catch(() => {});
        unbuttoned.add(card);
        elsewhere.push(card);
      }
      if (sent.ok) offered.push(pending.id);
    }
    // ONE TAP FOR ALL (Sean, 2026-11-02, voice-first: a debrief gives several tasks at once, and the person may be
    // driving). Each is shown above with its own Confirm; this confirms exactly those. A failed send costs nothing —
    // the single buttons, and "yes to all", still work.
    // The rest of a corrected set joins this offer: still waiting, this person's, phone rows only.
    const carried = offered.length && carry.length
      ? (await basePrisma.assistantPendingAction.updateMany({
          where: { id: { in: [...carry] }, tenantId, userId, forCrm: false, confirmedAt: null, completedAt: null, failedAt: null, expiresAt: { gt: new Date() } },
          data: { createdAt: offeredAt },
        })).count
      : 0;
    const inSet = offered.length + carried;
    if (inSet >= 2) {
      const body = carried
        ? `👆 ${whatsappBold(`That's ${inSet} tasks now`)} — the changed one above, and ${carried === 1 ? "the one" : `the ${carried}`} you already had. Tap Confirm all to do all ${inSet}.`
        : `👆 ${whatsappBold(`That's ${inSet} tasks`)}, each shown above. Tap Confirm all to do all ${inSet}.`;
      const all = await sendWhatsAppButtons(waId, body, [{ id: confirmAllButtonId(offered[0]), title: `${CONFIRM_TITLE} all ${inSet}` }], { footer: `Or reply "yes to all" · nothing changes till you do` });
      if (!all.ok) await logError("assistant-whatsapp", "confirm-all offer send failed");
    }
    if (elsewhere.length > 0) {
      // KEPT, not only named. These are done in the CRM — but the person has
      // already said what they want, so each is saved as a card on their Ask
      // page instead of having to be asked for again there. Saved first: the
      // message must not promise a card that is not there.
      const saved = await saveForCrm(tenantId, userId, elsewhere);
      const list = elsewhere.map((card) => `• ${card.title}`).join("\n");
      // Why it is in the CRM, truthfully: a button that failed to send is not "done in the CRM" by rule.
      const allUnbuttoned = elsewhere.every((card) => unbuttoned.has(card));
      await say(
        waId,
        saved && allUnbuttoned
          ? `I couldn't send the Confirm button for ${elsewhere.length === 1 ? "this one" : "these"}, so I've saved ${elsewhere.length === 1 ? "it" : "them"} on your Ask page in the CRM — open it and press Confirm (kept for a day):\n${list}`
          : saved
          ? `${elsewhere.length === 1 ? "This one is" : "These are"} done in the CRM. I've saved ${elsewhere.length === 1 ? "it" : "them"} on your Ask page — open it and press Confirm (kept for a day):\n${list}`
          : `${elsewhere.length === 1 ? "This one needs" : "These need"} the CRM — ask me there and confirm on the card:\n${list}`,
      );
    }
  } catch (error) {
    await logError("assistant-whatsapp", "offering confirmations failed", error instanceof Error ? error.name : "unknown").catch(() => {});
  }
}

/**
 * Cards for the CRM: the same table as a WhatsApp offer, marked `forCrm`, with a
 * day to be confirmed instead of fifteen minutes. A phone can never confirm one
 * — no button is sent for it and confirmFromWhatsApp does not read it — so what
 * a phone may change is exactly what it was before. True: all of them were saved.
 */
async function saveForCrm(tenantId: string, userId: string, cards: readonly ActionCard[]): Promise<boolean> {
  try {
    const expiresAt = new Date(Date.now() + CRM_CARD_TTL_MS);
    await basePrisma.assistantPendingAction.createMany({
      data: cards.map((card) => ({ tenantId, userId, card: card as object, expiresAt, forCrm: true })),
    });
    return true;
  } catch (error) {
    await logError("assistant-whatsapp", "saving a task for the CRM failed", error instanceof Error ? error.name : "unknown").catch(() => {});
    return false;
  }
}

/**
 * How long a pending task is kept after its 15-minute window has closed —
 * whether it was done, failed, or never tapped. A day: long enough to answer
 * "what happened when I tapped that?", short enough that a card (which names a
 * customer and can hold a note's text) is not kept for no reason. What was done
 * is in the audit trail and on the record itself; this row is only the offer.
 */
export const PENDING_ACTION_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Delete this workspace's pending tasks past their retention. Run by the assistant's cron tick. */
export async function prunePendingActions(tenantId: string, now = new Date()): Promise<number> {
  const removed = await basePrisma.assistantPendingAction.deleteMany({
    where: { tenantId, expiresAt: { lt: new Date(now.getTime() - PENDING_ACTION_RETENTION_MS) } },
  });
  return removed.count;
}

/** Next's redirect(), which the CRM's guards throw to refuse someone. Here it means: not allowed. */
const isRefusal = (error: unknown) =>
  typeof error === "object" && error !== null && "digest" in error && String((error as { digest: unknown }).digest).startsWith("NEXT_REDIRECT");

/**
 * Why a tap could not claim its task, said truthfully. "Already done" is only
 * said of a task that WAS done: the first version answered every unclaimable tap
 * with "already been done or it has expired", including one that had failed.
 */
async function whyNotClaimable(tenantId: string, userId: string, pendingId: string, now: Date): Promise<string> {
  const row = await basePrisma.assistantPendingAction.findFirst({
    // A card saved for the CRM reads as "no such task" here, like any id that was never a button.
    where: { id: pendingId, tenantId, userId, forCrm: false },
    select: { confirmedAt: true, completedAt: true, failedAt: true, expiresAt: true },
  });
  if (!row) return "That one can't be confirmed — ask me again if you still want it.";
  if (row.completedAt) return "That one is already done.";
  if (row.failedAt) return "That one failed when it was tried, and I can't tell how far it got — so it can't be tried again from here. Check the record in the CRM, then ask me again if it's still needed.";
  if (row.expiresAt.getTime() <= now.getTime()) return `That one has expired — a task can be confirmed for ${PENDING_ACTION_TTL_MS / 60_000} minutes. Ask me again if you still want it.`;
  return "That one is being done right now.";
}

/**
 * The Confirm button was tapped. Claims the pending task — once, by the person
 * it was offered to, before it expires — and runs it as that person.
 *
 * A pending task is in one of four states, and each ends differently:
 *
 *   waiting   confirmedAt null                       → can be claimed
 *   claimed   confirmedAt set, nothing else          → running (or the run died: it then simply expires)
 *   done      completedAt set                        → never runs again
 *   failed    failedAt set                           → never runs again
 *
 * AT MOST ONCE comes first. So what happens after a claim depends on whether we
 * KNOW nothing was changed:
 *  - it was turned away BEFORE anything that writes was called (out of date, the
 *    lead gone, an invalid schedule) and says so with `unchanged` — proof that
 *    nothing changed, so the claim is RELEASED and Confirm can be tapped again;
 *  - it came back with any other error, or threw — it may have got part-way (a
 *    note saved, its pin failed), so the task is marked FAILED
 *    and cannot be retried from a phone. Retrying an unknown is how a note gets
 *    written twice.
 */
export async function confirmFromWhatsApp(tenantId: string, user: PermissionUser, waId: string, pendingId: string): Promise<void> {
  if (!(await confirmingOnWhatsAppOn())) return say(waId, "Confirming on WhatsApp is switched off for this workspace — ask me in the CRM and confirm on the card.");

  const now = new Date();
  // The claim IS the check: one conditional update, so two taps (or a tap and a
  // redelivery) cannot both run it, and somebody else's, a finished or an expired one matches nothing.
  // (The workspace and person are written out in every query here, not spread in:
  // the tenant-access sweep reads the call site.)
  const claimed = await basePrisma.assistantPendingAction.updateMany({
    // forCrm: false — a card saved for the CRM is never confirmed from a phone, whatever id arrives.
    where: { id: pendingId, tenantId, userId: user.id, forCrm: false, confirmedAt: null, completedAt: null, failedAt: null, expiresAt: { gt: now } },
    data: { confirmedAt: now },
  });
  if (claimed.count !== 1) return say(waId, await whyNotClaimable(tenantId, user.id, pendingId, now));
  // Guarded on THIS claim, so a later tap's claim is never undone or overwritten by an earlier run finishing.
  const settle = (data: { completedAt?: Date; failedAt?: Date; confirmedAt?: null }) =>
    basePrisma.assistantPendingAction.updateMany({ where: { id: pendingId, tenantId, userId: user.id, confirmedAt: now, completedAt: null, failedAt: null }, data });

  const pending = await basePrisma.assistantPendingAction.findFirst({ where: { id: pendingId, tenantId, userId: user.id }, select: { card: true } });
  const card = pending?.card as ActionCard | undefined;
  // What was stored is what was offered, and only confirmable kinds are offered —
  // checked again, because this is the line that decides what a phone can change.
  if (!card || !WHATSAPP_CONFIRMABLE.has(String(card.kind))) {
    await settle({ failedAt: new Date() });
    return say(waId, "That one needs the CRM — ask me there and confirm on the card.");
  }

  let result: Awaited<ReturnType<typeof runAssistantAction>>;
  try {
    // "whatsapp": a built quote's PDF is sent from here, after the ✅ — not by the action itself.
    result = await runAsLinkedStaff(user.id, () => runAssistantAction(card, "whatsapp"));
  } catch (error) {
    // Anything thrown — a guard's refusal included — ends this task. A refusal
    // usually comes before any write, but from here it cannot be told apart from
    // one raised part-way through, and trying again would not change the answer.
    await settle({ failedAt: new Date() });
    if (isRefusal(error)) return say(waId, "You don't have permission to do that.");
    await logError("assistant-whatsapp", "confirmed action threw", error instanceof Error ? error.name : "unknown").catch(() => {});
    return say(waId, "That didn't go through, and I can't tell how far it got. Check the record in the CRM, then ask me again if it's still needed.");
  }
  if (!result.ok) {
    // RETRY ONLY ON PROOF. `unchanged` is set by runAssistantAction solely on a
    // refusal made before it called anything that writes. An error that came
    // back FROM the action is not that proof: adding a pinned note saves the
    // note, then pins it, and a failed pin returns an error with the note
    // already saved. Releasing on any error let a second tap write it twice.
    // `resumable` is the other proof: part WAS written (a quote's new customer record) and the retry finds it.
    if (result.unchanged === true || result.resumable === true) {
      await settle({ confirmedAt: null });
      return say(waId, `Not done: ${result.error ?? "it couldn't be completed."}\n\n${result.unchanged === true ? "Nothing was changed. " : ""}You can tap Confirm again (or reply yes) until it expires.`);
    }
    await settle({ failedAt: new Date() });
    return say(waId, `That didn't complete: ${result.error ?? "it couldn't be completed."}\n\nPart of it may have been saved, so I won't try it again from here. Check the record in the CRM, then ask me again if it's still needed.`);
  }
  await settle({ completedAt: new Date() });

  // runAssistantAction has written the CRM's own audit entries; this one records WHERE the click came from.
  await logAudit({
    action: "assistant.whatsapp_confirmed",
    summary: `Confirmed on WhatsApp: ${card.title}`,
    user,
    // On the record it changed: the lead's timeline, or the customer's for a customer note.
    ...("leadId" in card && card.leadId ? { leadId: card.leadId } : {}),
    ...(card.kind === "customer_note" || card.kind === "update_customer" ? { contactId: card.contactId } : {}),
    // A quote built for a customer directly (no deal) is recorded on the customer.
    ...((card.kind === "quote_build" || card.kind === "quote_add" || card.kind === "quote_change") && !card.leadId ? { contactId: card.contactId } : {}),
  });
  await say(waId, `✅ ${result.success ?? "Done"}`);
  // A quote it built: runAssistantAction has queued the PDF as an update for this
  // person, and the caller (handleStaffWhatsApp) sends what is waiting once this
  // returns. Nothing is sent to anyone from here beyond the line above.
}

/**
 * CONFIRM ALL — the button, or "yes to all" typed or said (Sean, 2026-11-02: voice-first). Every task offered
 * TOGETHER with `anchorId` (one offer shares one createdAt), or with the newest offer when there is no anchor; each
 * one still waiting is confirmed exactly as its own Confirm would be — claimed once, run as this person, its own ✅
 * or reason. Never an older offer, never a card saved for the CRM, never anyone else's.
 */
export async function confirmAllFromWhatsApp(tenantId: string, user: PermissionUser, waId: string, anchorId: string | null): Promise<void> {
  if (!(await confirmingOnWhatsAppOn())) return say(waId, "Confirming on WhatsApp is switched off for this workspace — ask me in the CRM and confirm on the card.");
  const now = new Date();
  // No anchor ("yes to all"): the NEWEST offer, whatever became of it — never the newest one still waiting, which
  // after the last set was done would be an older offer (review of #939). Done or expired: nothing remains.
  const anchor = anchorId
    ? await basePrisma.assistantPendingAction.findFirst({ where: { id: anchorId, tenantId, userId: user.id, forCrm: false }, select: { createdAt: true } })
    : await basePrisma.assistantPendingAction.findFirst({ where: { tenantId, userId: user.id, forCrm: false }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  const rows = anchor
    ? await basePrisma.assistantPendingAction.findMany({
        where: { tenantId, userId: user.id, forCrm: false, createdAt: anchor.createdAt, confirmedAt: null, completedAt: null, failedAt: null, expiresAt: { gt: now } },
        orderBy: { id: "asc" },
        select: { id: true },
      })
    : [];
  if (rows.length === 0) return say(waId, "Nothing from that set is waiting any more — each was done, or has expired. Ask me again if you still want something.");
  // One that throws (the database, for a moment) does not stop the rest — and is said, not skipped silently.
  for (const row of rows) {
    await confirmFromWhatsApp(tenantId, user, waId, row.id).catch(async (error: unknown) => {
      await logError("assistant-whatsapp", "confirm-all step threw", error instanceof Error ? error.name : "unknown").catch(() => {});
      await say(waId, "One of these couldn't be checked just now — look at it in the CRM, or tap its own Confirm again.");
    });
  }
}

/**
 * What waits for this person's Confirm here: how many in all, and those still waiting from the NEWEST offer (in the
 * order offered) — empty when the newest offer is all done, even if an older one still waits (review of #939).
 */
export async function waitingForConfirm(tenantId: string, userId: string): Promise<{
  total: number;
  newest: { id: string; title: string }[];
  only: { id: string; title: string } | null;
  /** Every task waiting, oldest first, with what its card shows — numbered to DAX so a correction can name one. */
  all: { id: string; title: string; detail?: string }[];
}> {
  const latest = await basePrisma.assistantPendingAction.findFirst({ where: { tenantId, userId, forCrm: false }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  const rows = await basePrisma.assistantPendingAction.findMany({
    where: { tenantId, userId, forCrm: false, confirmedAt: null, completedAt: null, failedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    take: 12,
    select: { id: true, createdAt: true, card: true },
  });
  const newestAt = latest?.createdAt.getTime();
  const shown = (row: (typeof rows)[number]) => ({ id: row.id, title: String((row.card as { title?: unknown } | null)?.title ?? "a task") });
  const newest = rows
    .filter((row) => row.createdAt.getTime() === newestAt)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map(shown);
  const all = [...rows]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
    .map((row) => {
      const card = (row.card ?? {}) as { detail?: unknown; text?: unknown };
      const detail = typeof card.detail === "string" ? card.detail : typeof card.text === "string" ? card.text : "";
      return { ...shown(row), ...(detail ? { detail: detail.slice(0, 300) } : {}) };
    });
  // The ONE task waiting, wherever it was offered: what a plain "yes" confirms (Sean, 2026-10-24).
  return { total: rows.length, newest, only: rows.length === 1 ? shown(rows[0]) : null, all };
}

/**
 * WITHDRAW waiting tasks (voice-first, 2026-11-02: "drop the follow-up", or the old version of one just corrected):
 * this person's own, still waiting, phone rows only — never one already claimed, done or failed, never a saved card.
 * Nothing in the CRM changes: only the offer goes. Returns the titles withdrawn.
 */
export async function withdrawWaiting(tenantId: string, userId: string, ids: readonly string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await basePrisma.assistantPendingAction.findMany({
    where: { id: { in: [...ids] }, tenantId, userId, forCrm: false, confirmedAt: null, completedAt: null, failedAt: null },
    select: { id: true, card: true },
  });
  // One at a time, each conditional: one confirmed meanwhile is not withdrawn — and not reported as withdrawn.
  const withdrawn: string[] = [];
  for (const row of rows) {
    const gone = await basePrisma.assistantPendingAction.deleteMany({
      where: { id: row.id, tenantId, userId, forCrm: false, confirmedAt: null, completedAt: null, failedAt: null },
    });
    if (gone.count === 1) withdrawn.push(String((row.card as { title?: unknown } | null)?.title ?? "a task"));
  }
  return withdrawn;
}

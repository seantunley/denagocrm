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
  PENDING_ACTION_TTL_MS,
  WHATSAPP_CONFIRMABLE,
  confirmButtonId,
  confirmPrompt,
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
export async function offerConfirmations(tenantId: string, userId: string, waId: string, cards: readonly ActionCard[]): Promise<void> {
  if (cards.length === 0) return;
  try {
    const on = await confirmingOnWhatsAppOn();
    const { confirmable, crmOnly } = splitForWhatsApp_cards(cards);
    const offered = on ? confirmable : [];
    const elsewhere = on ? crmOnly : [...cards];
    for (const card of offered) {
      const pending = await basePrisma.assistantPendingAction.create({
        data: { tenantId, userId, card: card as object, expiresAt: new Date(Date.now() + PENDING_ACTION_TTL_MS) },
        select: { id: true },
      });
      const sent = await sendWhatsAppButtons(waId, confirmPrompt(card), [{ id: confirmButtonId(pending.id), title: "Confirm" }]);
      if (!sent.ok) await logError("assistant-whatsapp", "confirm offer send failed");
    }
    if (elsewhere.length > 0) {
      await say(waId, `${elsewhere.length === 1 ? "This one needs" : "These need"} the CRM — ask me there and confirm on the card:\n${elsewhere.map((card) => `• ${card.title}`).join("\n")}`);
    }
  } catch (error) {
    await logError("assistant-whatsapp", "offering confirmations failed", error instanceof Error ? error.name : "unknown").catch(() => {});
  }
}

/** Next's redirect(), which the CRM's guards throw to refuse someone. Here it means: not allowed. */
const isRefusal = (error: unknown) =>
  typeof error === "object" && error !== null && "digest" in error && String((error as { digest: unknown }).digest).startsWith("NEXT_REDIRECT");

/**
 * The Confirm button was tapped. Claims the pending task — once, by the person
 * it was offered to, before it expires — and runs it as that person.
 */
export async function confirmFromWhatsApp(tenantId: string, user: PermissionUser, waId: string, pendingId: string): Promise<void> {
  if (!(await confirmingOnWhatsAppOn())) return say(waId, "Confirming on WhatsApp is switched off for this workspace — ask me in the CRM and confirm on the card.");

  const now = new Date();
  // The claim IS the check: one conditional update, so two taps (or a tap and a
  // redelivery) cannot both run it, and somebody else's or an expired one matches nothing.
  const claimed = await basePrisma.assistantPendingAction.updateMany({
    where: { id: pendingId, tenantId, userId: user.id, confirmedAt: null, expiresAt: { gt: now } },
    data: { confirmedAt: now },
  });
  if (claimed.count !== 1) return say(waId, "That one can't be confirmed any more — it has already been done or it has expired. Ask me again if you still want it.");

  const pending = await basePrisma.assistantPendingAction.findFirst({ where: { id: pendingId, tenantId, userId: user.id }, select: { card: true } });
  const card = pending?.card as ActionCard | undefined;
  // What was stored is what was offered, and only confirmable kinds are offered —
  // checked again, because this is the line that decides what a phone can change.
  if (!card || !WHATSAPP_CONFIRMABLE.has(String(card.kind))) return say(waId, "That one needs the CRM — ask me there and confirm on the card.");

  let result: Awaited<ReturnType<typeof runAssistantAction>>;
  try {
    result = await runAsLinkedStaff(user.id, () => runAssistantAction(card));
  } catch (error) {
    if (isRefusal(error)) return say(waId, "You don't have permission to do that.");
    await logError("assistant-whatsapp", "confirmed action threw", error instanceof Error ? error.name : "unknown").catch(() => {});
    return say(waId, "That didn't go through. Check the record in the CRM before trying again.");
  }
  if (!result.ok) return say(waId, `Not done: ${result.error ?? "it couldn't be completed."}`);

  // runAssistantAction has written the CRM's own audit entries; this one records WHERE the click came from.
  await logAudit({
    action: "assistant.whatsapp_confirmed",
    summary: `Confirmed on WhatsApp: ${card.title}`,
    user,
    ...("leadId" in card && card.leadId ? { leadId: card.leadId } : {}),
  });
  return say(waId, `✅ ${result.success ?? "Done"}`);
}

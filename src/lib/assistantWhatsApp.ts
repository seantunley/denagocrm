import "server-only";
import crypto from "crypto";
import { basePrisma } from "./db";
import { getSetting } from "./settings";
import { currentTenantScope } from "./tenantScope";
import { fetchWhatsAppMedia, sendWhatsAppButtons, sendWhatsAppText, waDigits } from "./whatsapp";
import { transcribeVoice } from "./transcribe";
import { askCrm } from "./crmAssistant";
import { ASK_LIMIT_MESSAGE, assistantAskAllowed, assistantUserFor } from "./assistantUser";
import { ASSISTANT_PROFILE_KEY, parseProfile } from "./assistantSoul";
import { logAudit } from "./audit";
import { logError } from "./errorLog";
import { checkRateLimit, rateLimitKey, registerRateLimitAttempt } from "./rateLimit";
import {
  ASSISTANT_WHATSAPP_KEY,
  LINK_GUESS_POLICY,
  QUESTION_CHARS,
  businessNumberFromLabel,
  linkCodeHashInput,
  maskWaId,
  parseLinkCode,
  planWhatsAppReply,
  whatsappSwitchOn,
  type WhatsAppReplyPlan,
} from "./assistantWhatsAppRules";

/*
 * DAX on WhatsApp, the webhook half. The rules (and the threat) are written up in
 * assistantWhatsAppRules.ts; this file is where they meet the database and Meta.
 *
 * ONE QUESTION DECIDES EVERYTHING: is the sender a number a staff member PROVED
 * is theirs, in the workspace that owns the business number? Only a definite yes
 * routes a message here. Every no — switch off, no workspace, unknown number, a
 * code that matches nothing, a person who has since lost access — returns false,
 * and the route carries on down today's customer path untouched. Failing towards
 * "customer" is the safe direction: the worst case is a staff member's message in
 * the inbox, never CRM data in a customer's chat.
 *
 * Every read and write names its workspace explicitly, from the scope the route
 * entered for the business number (withChannelTenantScope). No scope means no
 * workspace owns that number, and then nobody on it is staff.
 *
 * POPIA: nothing logged here carries message text, a question, an answer or a
 * phone number. Audit lines show a number masked to its last three digits.
 */

/** sha256 of the code, bound to its workspace and person — see linkCodeHashInput. */
export function hashLinkCode(tenantId: string, userId: string, code: string): string {
  return crypto.createHash("sha256").update(linkCodeHashInput(tenantId, userId, code)).digest("hex");
}

/** Constant-time compare of two hex digests. */
function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

/** Is the switch on for the workspace in scope? */
export async function assistantWhatsAppOn(): Promise<boolean> {
  return whatsappSwitchOn(await getSetting(ASSISTANT_WHATSAPP_KEY));
}

/** The number staff send their code to, when the endpoint's label carries it. */
export async function businessWhatsAppNumber(tenantId: string) {
  const endpoint = await basePrisma.channelIdentity.findFirst({
    where: { tenantId, channel: "whatsapp", disabledAt: null },
    orderBy: { createdAt: "asc" },
    select: { label: true },
  });
  return businessNumberFromLabel(endpoint?.label);
}

export type StaffWhatsAppInput = { text: string } | { voiceMediaId: string };

/**
 * A message to the business number. True: it was a staff member's (or their link
 * code) and it has been dealt with — the route must NOT record it as a customer
 * message or run the chatbot. False: carry on exactly as before.
 *
 * Errors before the answer (a lookup failing) propagate: the route releases the
 * claim and Meta redelivers, and the redelivery asks the same question again. They
 * never turn into `false`, because "couldn't tell" is not "customer".
 */
export async function handleStaffWhatsApp(from: string, input: StaffWhatsAppInput): Promise<boolean> {
  // A REAL workspace scope or nothing. withChannelTenantScope binds one only
  // when the business number is mapped to a workspace; an unmapped number runs
  // with no scope (dormant) or not at all (enforcing). A system scope bypasses
  // RLS, so a link lookup there would search every workspace's phones — never.
  const scope = currentTenantScope();
  if (!scope || scope.system || !scope.tenantId) return false;
  const tenantId = scope.tenantId;
  if (!(await assistantWhatsAppOn())) return false;
  const waId = waDigits(String(from ?? ""));
  if (!waId) return false;

  // A link code. A match proves this phone belongs to the person who asked for it.
  // No match falls through: it may still be a linked staff number (a typo), and
  // if not, the route files it as the customer message it is.
  const code = "text" in input ? parseLinkCode(input.text) : null;
  if (code && (await verifyLinkCode(tenantId, waId, code))) return true;

  const link = await basePrisma.assistantPhoneLink.findFirst({
    where: { tenantId, waId, verifiedAt: { not: null } },
    select: { userId: true },
  });
  if (!link) return false;
  // Re-checked on every message: still an active member, still allowed to use
  // the assistant, Automation & AI still on. Gone → their messages are treated
  // as anyone's, and the link stays for the owner to see.
  const user = await assistantUserFor(link.userId);
  if (!user) return false;

  // The person's ONE ask limit, shared with the page and the bubble — a phone is
  // not a second allowance. Counted before a voice note is fetched or
  // transcribed, so the cap bounds that work too.
  if (!(await assistantAskAllowed(user.id))) {
    await sendPlan(waId, { texts: [ASK_LIMIT_MESSAGE], buttons: null });
    return true;
  }

  let question = "text" in input ? input.text : null;
  if ("voiceMediaId" in input) {
    // Only now — after the number is known to be staff — is the voice note
    // downloaded. A customer's voice note never reaches this line.
    const media = await fetchWhatsAppMedia(input.voiceMediaId).catch(() => null);
    question = media ? await transcribeVoice(media.buffer, media.contentType).catch(() => null) : null;
    if (!question) {
      await sendPlan(waId, { texts: ["I couldn't make out that voice note — try again, or type it."], buttons: null });
      return true;
    }
  }
  const q = String(question ?? "").trim().slice(0, QUESTION_CHARS);
  if (!q) {
    await sendPlan(waId, { texts: ["Ask me anything about your leads, quotes or calendar."], buttons: null });
    return true;
  }

  // The AssistantTurn askCrm saves (source "whatsapp") is the record of this
  // exchange. It is never a customer Communication, never a lead, never the bot.
  let plan: WhatsAppReplyPlan;
  try {
    const result = await askCrm(user, q, null, { source: "whatsapp" });
    plan = result.ok ? planWhatsAppReply(result.answer, result.choices) : { texts: [result.error], buttons: null };
  } catch (error) {
    await logError("assistant-whatsapp", "answering failed", error instanceof Error ? error.name : "unknown").catch(() => {});
    plan = { texts: ["Something went wrong answering that — try again in a minute."], buttons: null };
  }
  await sendPlan(waId, plan);
  return true;
}

/**
 * "DAX 123456" from `waId`: find the ONE pending code in this workspace it
 * matches, and link this number — and only this number — to that person.
 */
async function verifyLinkCode(tenantId: string, waId: string, code: string): Promise<boolean> {
  // Guesses are limited per sending number; a blocked number's codes are not
  // even compared.
  const guessKey = rateLimitKey("assistant-wa-guess", `${tenantId}:${waId}`);
  if (!(await checkRateLimit(guessKey)).allowed) return false;

  const now = new Date();
  const pending = await basePrisma.assistantPhoneLink.findMany({
    where: { tenantId, codeHash: { not: null }, codeExpiresAt: { gt: now } },
    select: { id: true, userId: true, codeHash: true },
  });
  // Every row is compared (no early exit). Two people holding the same six
  // digits at once is possible (one in a million) — and then the code does not
  // say WHICH person, so it links neither; both just ask for a new one.
  const matches = pending.filter((row) => row.codeHash && sameHash(row.codeHash, hashLinkCode(tenantId, row.userId, code)));
  const match = matches.length === 1 ? matches[0] : null;
  const user = match ? await assistantUserFor(match.userId) : null;
  if (!match || !user) {
    await registerRateLimitAttempt(guessKey, LINK_GUESS_POLICY);
    return false;
  }

  const linked = await basePrisma.$transaction(async (tx) => {
    // One workspace's links change one at a time, so "who holds this number"
    // can't be answered twice at once.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`assistant-wa-link:${tenantId}`})::bigint)`;
    // One number, one person: whoever held this number before no longer does.
    await tx.assistantPhoneLink.updateMany({
      where: { tenantId, waId, id: { not: match.id } },
      data: { waId: null, verifiedAt: null },
    });
    // The code is used up here; guarded on the same hash so a code replaced or
    // used in the meantime links nothing.
    const done = await tx.assistantPhoneLink.updateMany({
      where: { id: match.id, tenantId, codeHash: match.codeHash, codeExpiresAt: { gt: now } },
      data: { waId, verifiedAt: now, codeHash: null, codeExpiresAt: null },
    });
    return done.count === 1;
  });
  if (!linked) return false;

  await logAudit({
    action: "assistant.whatsapp_linked",
    summary: `Linked WhatsApp ${maskWaId(waId)} to ask the assistant (proved by code)`,
    user,
    entityType: "AssistantPhoneLink",
    entityId: match.id,
  });
  const name = parseProfile(await getSetting(ASSISTANT_PROFILE_KEY).catch(() => null)).name;
  await sendPlan(waId, { texts: [`✅ Linked — I'm ${name}. Ask me anything about your leads, quotes or calendar.`], buttons: null });
  return true;
}

/**
 * Send a reply to a staff member. Never with a customer `record`, so nothing
 * lands on a customer timeline. A failure is logged as a reason only, and
 * swallowed: the inbound message WAS handled, and throwing would have Meta
 * redeliver it — into the same answer, at the same cost.
 */
async function sendPlan(waId: string, plan: WhatsAppReplyPlan): Promise<void> {
  try {
    for (const text of plan.texts) {
      const sent = await sendWhatsAppText(waId, text);
      if (!sent.ok) {
        await logError("assistant-whatsapp", "reply send failed");
        return;
      }
    }
    if (plan.buttons) {
      const buttons = plan.buttons.titles.map((title, i) => ({ id: `dax:${i}`, title }));
      const sent = await sendWhatsAppButtons(waId, plan.buttons.body, buttons);
      if (!sent.ok) await logError("assistant-whatsapp", "reply buttons send failed");
    }
  } catch (error) {
    await logError("assistant-whatsapp", "reply send threw", error instanceof Error ? error.name : "unknown").catch(() => {});
  }
}

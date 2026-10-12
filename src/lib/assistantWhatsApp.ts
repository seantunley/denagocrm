import "server-only";
import crypto from "crypto";
import { basePrisma } from "./db";
import { getSetting } from "./settings";
import { currentTenantScope } from "./tenantScope";
import { fetchWhatsAppMedia, matchByPhone, sendWhatsAppAudioId, sendWhatsAppButtons, sendWhatsAppTemplate, sendWhatsAppText, showWhatsAppTyping, uploadWhatsAppMedia, waDigits } from "./whatsapp";
import { transcribeVoice, transcribeVoiceDetailed } from "./transcribe";
import { askCrm } from "./crmAssistant";
import type { ActionCard } from "./assistantActions";
import { confirmFromWhatsApp, confirmingOnWhatsAppOn, offerConfirmations } from "./assistantWhatsAppConfirm";
import { ASK_LIMIT_MESSAGE, assistantAskAllowed, assistantImageAllowed, assistantUserFor, assistantVoiceReplyAllowed } from "./assistantUser";
import { MAX_IMAGE_BYTES, cleanJpeg, jpegDataUrl } from "./assistantImage";
import { canSynthesizeVoice } from "./elevenlabs";
import { synthesiseAnswer } from "./assistantVoice";
import { ASSISTANT_VOICE_REPLIES_KEY, voiceLanguageFor, voiceRepliesSwitchOn } from "./assistantVoiceRules";
import { voiceLanguage, type VoiceLanguage } from "./voiceLanguage";
import { ASSISTANT_PROFILE_KEY, parseProfile } from "./assistantSoul";
import { logAudit } from "./audit";
import { logError } from "./errorLog";
import { rateLimitKey, registerRateLimitAttempt } from "./rateLimit";
import { readUserSecurityStateStrict } from "./userSecurity";
import {
  ASSISTANT_WHATSAPP_KEY,
  ASSISTANT_WHATSAPP_TEMPLATE_KEY,
  LINK_GUESS_POLICY,
  LINK_GUESS_WORKSPACE_POLICY,
  NUDGE_EVERY_MS,
  NUDGE_RETRY_MS,
  UPDATE_CLAIM_MS,
  UPDATE_MAX,
  UPDATE_SEND_RESERVE_MS,
  nudgeFailureMayPass,
  PROACTIVE_SOURCES,
  QUESTION_CHARS,
  UPDATE_BATCH,
  UPDATE_WAIT_MS,
  businessNumberFromLabel,
  linkCodeHashInput,
  maskWaId,
  outsideReplyWindow,
  parseConfirmId,
  parseLinkCode,
  parseUpdateTemplate,
  planWhatsAppReply,
  replyWindowOpen,
  splitForWhatsApp,
  updateText,
  whatsappSwitchOn,
  type LinkRefusal,
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

export type StaffWhatsAppInput =
  /** choiceId: the id of a tapped button, when the text is a button's title. */
  /** templateReply: the tap on a message template's button ("Show me") — the way in, not a question. */
  | { text: string; choiceId?: string; templateReply?: boolean }
  | { voiceMediaId: string }
  /** A photo, file or video. Only a photo can be read; the others are answered with why not. */
  | { mediaId: string; mediaKind: "image" | "document" | "video"; caption: string };

const IMAGE_QUESTION = "What's in this image, and what should I do with it?";

/**
 * A message to the business number. True: it was a staff member's (or their link
 * code) and it has been dealt with — the route must NOT record it as a customer
 * message or run the chatbot. False: carry on exactly as before.
 *
 * Errors before the answer (a lookup failing) propagate: the route releases the
 * claim and Meta redelivers, and the redelivery asks the same question again. They
 * never turn into `false`, because "couldn't tell" is not "customer".
 */
export async function handleStaffWhatsApp(from: string, input: StaffWhatsAppInput, messageId?: string | null): Promise<boolean> {
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
    select: { id: true, userId: true, sessionVersion: true },
  });
  if (!link) return false;
  // A LINKED PHONE IS A SIGN-IN, and dies with the others. It carries the
  // account's sessionVersion from when its code was issued; a password change
  // or reset, "sign out everywhere", an email change or a disable bumps it, and
  // from then on this number is nobody's — the link is cleared (audited), the
  // number is told once why, and after that it is treated as anyone's. Without
  // this, a phone linked from a stolen session outlived every remedy.
  // Strict: a database error throws (the route releases the claim and Meta
  // redelivers) — it never reads as "version 0, still valid".
  const security = await readUserSecurityStateStrict(link.userId);
  if (!security || link.sessionVersion === null || security.sessionVersion !== link.sessionVersion) {
    // Guarded on exactly the link we read: a re-link made since then is not
    // wiped, and of two messages arriving together only one sends the notice.
    const cleared = await basePrisma.assistantPhoneLink.updateMany({
      where: { id: link.id, tenantId, waId, sessionVersion: link.sessionVersion },
      data: { waId: null, verifiedAt: null, sessionVersion: null },
    });
    if (cleared.count !== 1) return false;
    await logAudit({
      action: "assistant.whatsapp_unlinked",
      summary: `WhatsApp ${maskWaId(waId)} unlinked from the assistant: the account's sign-ins were reset`,
      entityType: "AssistantPhoneLink",
      entityId: link.id,
    });
    // Said once, to the number that WAS linked — no data, just why it stopped —
    // so the person isn't left with the chatbot answering them as a customer.
    // Their next message (no link now) takes the customer path as normal.
    await sendPlan(waId, {
      texts: ["This number is no longer linked to the assistant (your sign-ins were reset). Link it again from the Ask page in the CRM."],
      buttons: null,
    });
    return true;
  }
  // A CUSTOMER'S NUMBER IS NEVER STAFF — re-checked on EVERY message, not only
  // when the number was linked. A number that has since landed on a customer
  // record or open lead in this workspace (or can't be told apart) is no
  // longer a safe place to send CRM answers: the link is cleared (guarded on
  // exactly the link read), audited, and this message takes the customer path
  // — no DAX reply, because the person holding that phone may be the customer.
  const customer = await matchByPhone(waId);
  if (customer.contactId || customer.leadId || customer.ambiguous) {
    const cleared = await basePrisma.assistantPhoneLink.updateMany({
      where: { id: link.id, tenantId, waId, sessionVersion: link.sessionVersion },
      data: { waId: null, verifiedAt: null, sessionVersion: null },
    });
    if (cleared.count === 1) {
      await logAudit({
        action: "assistant.whatsapp_unlinked",
        summary: `WhatsApp ${maskWaId(waId)} unlinked from the assistant: that number is now on a customer record`,
        entityType: "AssistantPhoneLink",
        entityId: link.id,
      });
    }
    return false;
  }
  // Re-checked on every message: still an active member, still allowed to use
  // the assistant, Automation & AI still on. Gone → their messages are treated
  // as anyone's, and the link stays for the owner to see.
  const user = await assistantUserFor(link.userId);
  if (!user) return false;

  // THEY HAVE JUST WRITTEN, so WhatsApp's 24 hours are open: whatever the
  // assistant produced on its own and could not send (a scheduled briefing, a
  // watch alert) goes now, before the answer to this message. The "you have an
  // update" template may be sent again after their next silence. Recorded here,
  // after every check above: only a message from verified staff opens it.
  await basePrisma.assistantPhoneLink.updateMany({ where: { id: link.id, tenantId, waId }, data: { lastInboundAt: new Date(), nudgedAt: null, nudgeFailedAt: null } });
  const caughtUp = await sendUpdatesToLinkedPhone(tenantId, user.id, { windowOpen: true });
  // A backlog past what one message may carry: said, never silently left behind.
  if (caughtUp === "more") await sendPlan(waId, { texts: ["There are more updates waiting. Send me any message and I'll carry on — they are all in the CRM too."], buttons: null });
  // The tap on the template's button asks nothing: it was only the way in.
  if ("text" in input && input.templateReply) {
    // Never "nothing is waiting" when something is and could not be sent.
    if (caughtUp === "more") return true;
    if (caughtUp === "failed" || caughtUp === "not_safe") await sendPlan(waId, { texts: ["I couldn't send your update here just now. It is in the CRM, on the Ask page."], buttons: null });
    else if (caughtUp !== "sent") await sendPlan(waId, { texts: ["Nothing new is waiting — it is all in the CRM. Ask me anything."], buttons: null });
    return true;
  }

  // A tapped Confirm button on a task proposed here earlier. Reached only now —
  // every check above has passed for THIS message — and it is not a question:
  // nothing is asked, and it does not count against the ask limit.
  const pendingId = "text" in input ? parseConfirmId(input.choiceId) : null;
  if (pendingId) {
    await confirmFromWhatsApp(tenantId, user, waId, pendingId);
    return true;
  }

  // The person's ONE ask limit, shared with the page and the bubble — a phone is
  // not a second allowance. Counted before a voice note is fetched or
  // transcribed, so the cap bounds that work too.
  if (!(await assistantAskAllowed(user.id))) {
    await sendPlan(waId, { texts: [ASK_LIMIT_MESSAGE], buttons: null });
    return true;
  }

  // "typing…" while the answer is worked out. Only HERE — after the number is
  // known to be a current staff member's and their limit allows the question —
  // so a customer's chat never shows it and their message is never marked read
  // by us. Started, not awaited: it must not delay the answer (it cannot reject).
  // ponytail: Meta drops the indicator after 25 seconds and it is not renewed;
  // re-send it on a timer if answers routinely take longer than that.
  const typing = showWhatsAppTyping(messageId);

  let question = "text" in input ? input.text : null;
  // A voice note in gets a voice note back — only when the owner switched voice
  // replies on (they cost ElevenLabs credits). A typed question is answered in text.
  const voiceBack = "voiceMediaId" in input && voiceRepliesSwitchOn(await getSetting(ASSISTANT_VOICE_REPLIES_KEY));
  let heard: VoiceLanguage | null = null;
  if ("voiceMediaId" in input) {
    // Only now — after the number is known to be staff — is the voice note
    // downloaded. A customer's voice note never reaches this line.
    const media = await fetchWhatsAppMedia(input.voiceMediaId).catch(() => null);
    if (media && voiceBack) {
      // Which language it was spoken in, too: an isiZulu question answered in
      // isiZulu can't be voiced, and an Afrikaans one needs the Afrikaans model.
      const transcript = await transcribeVoiceDetailed(media.buffer, media.contentType).catch(() => null);
      question = transcript?.text ?? null;
      heard = voiceLanguage(transcript?.languageCode, transcript?.languageProbability);
    } else {
      question = media ? await transcribeVoice(media.buffer, media.contentType).catch(() => null) : null;
    }
    if (!question) {
      await sendPlan(waId, { texts: ["I couldn't make out that voice note — try again, or type it."], buttons: null });
      return true;
    }
  }
  // A photo: read it, as the Ask page does, under the same limits (JPEG only,
  // size-capped, rebuilt by cleanJpeg so no metadata reaches the model, the
  // person's hourly image allowance). Downloaded only here — after the number is
  // known to be staff. A file or video is not read; the person is told, and the
  // message still ends here rather than being filed as a customer's.
  let images: string[] = [];
  if ("mediaKind" in input) {
    const say = async (text: string) => { await sendPlan(waId, { texts: [text], buttons: null }); await typing; return true; };
    if (input.mediaKind !== "image") return say("I can read photos and screenshots, but not files or videos yet. Send it as a photo, or type your question.");
    if (!(await assistantImageAllowed(user.id))) return say("That's a lot of images this hour — give it a while and try again.");
    const media = input.mediaId ? await fetchWhatsAppMedia(input.mediaId).catch(() => null) : null;
    const cleaned = media && media.contentType.startsWith("image/jpeg") && media.buffer.length <= MAX_IMAGE_BYTES ? cleanJpeg(new Uint8Array(media.buffer)) : null;
    if (!cleaned) return say("I couldn't read that image — try sending it again as a photo.");
    images = [jpegDataUrl(cleaned)];
    question = input.caption.trim() || IMAGE_QUESTION;
  }
  const q = String(question ?? "").trim().slice(0, QUESTION_CHARS);
  if (!q) {
    await sendPlan(waId, { texts: ["Ask me anything about your leads, quotes or calendar."], buttons: null });
    return true;
  }

  // The AssistantTurn askCrm saves (source "whatsapp") is the record of this
  // exchange. It is never a customer Communication, never a lead, never the bot.
  let plan: WhatsAppReplyPlan;
  let answer: string | null = null;
  let proposed: ActionCard[] = [];
  try {
    // Tasks are proposed only when the owner lets them be confirmed here.
    const result = await askCrm(user, q, null, { source: "whatsapp", images, proposeTasks: await confirmingOnWhatsAppOn() });
    if (result.ok) proposed = result.actions;
    plan = result.ok ? planWhatsAppReply(result.answer, result.choices) : { texts: [result.error], buttons: null };
    if (result.ok) answer = result.answer;
  } catch (error) {
    await logError("assistant-whatsapp", "answering failed", error instanceof Error ? error.name : "unknown").catch(() => {});
    plan = { texts: ["Something went wrong answering that — try again in a minute."], buttons: null };
  }
  // The full text ALWAYS goes, and first: it is the record, and it arrives while
  // the voice is still being made. The voice note is a convenience on top.
  await sendPlan(waId, plan);
  if (voiceBack && answer) await sendVoiceAnswer(user.id, waId, answer, heard);
  // After the answer (and its voice note): each task it set up, with its Confirm button.
  await offerConfirmations(tenantId, user.id, waId, proposed);
  // Settled before the function ends, so the request is never left running on a serverless host.
  await typing;
  return true;
}

/**
 * The spoken version of an answer, as a WhatsApp voice note — the customer
 * chatbot's path (ElevenLabs OGG/Opus, uploaded to Meta by media id, so we never
 * publish a URL of our own). Anything that stops it — no voice set up, a
 * language no model speaks, the person's hourly cap, ElevenLabs or Meta failing —
 * just means no voice note: they already have the text. Logged as a reason only.
 */
async function sendVoiceAnswer(userId: string, waId: string, answer: string, heard: VoiceLanguage | null): Promise<void> {
  try {
    // Checked before the cap is counted, so a text-only answer doesn't use it up.
    if (!(await canSynthesizeVoice()) || !voiceLanguageFor(answer, heard)) return;
    if (!(await assistantVoiceReplyAllowed(userId))) return;
    const audio = await synthesiseAnswer(answer, heard);
    if (typeof audio === "string") return; // ElevenLabs logs its own failure
    // .ogg so WhatsApp shows it as a voice note (waveform), not an audio file.
    const uploaded = await uploadWhatsAppMedia(audio.buffer, audio.contentType, "voice-reply.ogg");
    if (!("id" in uploaded)) {
      await logError("assistant-whatsapp", "voice reply upload failed");
      return;
    }
    const sent = await sendWhatsAppAudioId(waId, uploaded.id);
    if (!sent.ok) await logError("assistant-whatsapp", "voice reply send failed");
  } catch (error) {
    await logError("assistant-whatsapp", "voice reply threw", error instanceof Error ? error.name : "unknown").catch(() => {});
  }
}

/**
 * "DAX 123456" from `waId`: find the ONE pending code in this workspace it
 * matches, and link this number — and only this number — to that person.
 */
async function verifyLinkCode(tenantId: string, waId: string, code: string): Promise<boolean> {
  // Guesses are limited per sending number; a blocked number's codes are not
  // even compared.
  //
  // EVERY attempt is counted BEFORE any comparison (a check-then-register pair
  // let parallel deliveries all pass before the block landed), per sending
  // number AND across the workspace, so many numbers can't share the guessing.
  const perNumber = await registerRateLimitAttempt(rateLimitKey("assistant-wa-guess", `${tenantId}:${waId}`), LINK_GUESS_POLICY);
  // A number that's already blocked stops here — it doesn't get to keep the
  // workspace counter full and lock every colleague out of linking.
  if (!perNumber.allowed) {
    // Someone guessing link codes: logged once, when the block starts.
    if (perNumber.retryAfterSeconds * 1000 >= LINK_GUESS_POLICY.blockMs) {
      await logError("assistant-whatsapp", "link code guessing blocked for a number");
    }
    return false;
  }
  const perWorkspace = await registerRateLimitAttempt(rateLimitKey("assistant-wa-guess-ws", tenantId), LINK_GUESS_WORKSPACE_POLICY);
  if (!perWorkspace.allowed) {
    if (perWorkspace.retryAfterSeconds * 1000 >= LINK_GUESS_WORKSPACE_POLICY.blockMs) {
      await logError("assistant-whatsapp", "link code guessing blocked for the workspace");
    }
    return false;
  }

  const now = new Date();
  const pending = await basePrisma.assistantPhoneLink.findMany({
    where: { tenantId, codeHash: { not: null }, codeExpiresAt: { gt: now } },
    select: { id: true, userId: true, codeHash: true, sessionVersion: true },
  });
  // Every row is compared (no early exit). Two people holding the same six
  // digits at once is possible (one in a million) — and then the code does not
  // say WHICH person, so it links neither; both just ask for a new one.
  const matches = pending.filter((row) => row.codeHash && sameHash(row.codeHash, hashLinkCode(tenantId, row.userId, code)));
  const match = matches.length === 1 ? matches[0] : null;
  const user = match ? await assistantUserFor(match.userId) : null;
  if (!match || !user) return false;
  // The account's sign-in version now, so the link dies with its other sign-ins.
  const security = await readUserSecurityStateStrict(match.userId);
  if (!security) return false;
  // The code is only good under the sign-ins it was ISSUED with. One asked for
  // before a password reset or "sign out everywhere" is burnt, not redeemed —
  // otherwise a code fetched from a stolen session would link after the reset.
  if (match.sessionVersion === null || security.sessionVersion !== match.sessionVersion) {
    await basePrisma.assistantPhoneLink.updateMany({
      where: { id: match.id, tenantId, codeHash: match.codeHash },
      data: { codeHash: null, codeExpiresAt: null, refusedReason: "signed_out" satisfies LinkRefusal },
    });
    await logAudit({
      action: "assistant.whatsapp_link_refused",
      summary: `Refused to link WhatsApp ${maskWaId(waId)}: the code was issued before this account's sign-ins were reset`,
      user,
      entityType: "AssistantPhoneLink",
      entityId: match.id,
    });
    return false;
  }

  // A CUSTOMER'S NUMBER IS NEVER LINKED, even with a valid code. The code proves
  // possession of a phone, not whose phone it is: a staff member talked into it
  // (or tricked) could have a customer send it, and that customer would then
  // receive DAX's answers. Any number on a customer record or open lead in this
  // workspace — or one that can't be told apart — is refused, the code is burnt
  // so it can't be retried, and the message carries on as the customer message
  // it may well be. matchByPhone names this workspace explicitly.
  const customer = await matchByPhone(waId);
  if (customer.contactId || customer.leadId || customer.ambiguous) {
    await basePrisma.assistantPhoneLink.updateMany({
      where: { id: match.id, tenantId, codeHash: match.codeHash },
      data: { codeHash: null, codeExpiresAt: null, refusedReason: "customer_number" satisfies LinkRefusal },
    });
    await logAudit({
      action: "assistant.whatsapp_link_refused",
      summary: `Refused to link WhatsApp ${maskWaId(waId)}: that number is on a customer record`,
      user,
      entityType: "AssistantPhoneLink",
      entityId: match.id,
    });
    return false;
  }

  const linked = await basePrisma.$transaction(async (tx) => {
    // One workspace's links change one at a time, so "who holds this number"
    // can't be answered twice at once.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`assistant-wa-link:${tenantId}`})::bigint)`;
    // One number, one person: whoever held this number before no longer does.
    await tx.assistantPhoneLink.updateMany({
      where: { tenantId, waId, id: { not: match.id } },
      data: { waId: null, verifiedAt: null, sessionVersion: null },
    });
    // The code is used up here; guarded on the same hash so a code replaced or
    // used in the meantime links nothing.
    const done = await tx.assistantPhoneLink.updateMany({
      where: { id: match.id, tenantId, codeHash: match.codeHash, codeExpiresAt: { gt: now } },
      data: { waId, verifiedAt: now, codeHash: null, codeExpiresAt: null, refusedReason: null, sessionVersion: security.sessionVersion, lastInboundAt: now, nudgedAt: null, nudgeFailedAt: null },
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

export type UpdateDelivery =
  /** Everything waiting went to the person's linked phone. */
  | "sent"
  /** Nothing was waiting. */
  | "nothing"
  /** Nowhere to send: the workspace switch is off, no linked phone, or the person turned this off. */
  | "not_wanted"
  /** A linked phone exists but is no longer safely theirs — sign-ins reset, or the number is now on a customer record. */
  | "not_safe"
  /** WhatsApp would not take a message, so the approved template went instead: "you have an update". */
  | "nudged"
  /** WhatsApp would not take a message and there is no template to send (or one went recently). It waits. */
  | "waiting"
  /** UPDATE_MAX went and there are more: the next message from them, or the next tick, carries on. */
  | "more"
  | "failed";

/**
 * What the assistant produces ON ITS OWN — a scheduled briefing, a watch alert —
 * sent to the phone the person linked, as well as (never instead of) their
 * history in the CRM. Sean, 2026-10-12: "it arrived on the desktop DAX but not
 * WhatsApp … DAX must be able to send me things proactively."
 *
 * WHAT IS WAITING is read from the person's own history: schedule and watch
 * turns from the last day that have not gone to WhatsApp yet. So this needs no
 * queue of its own, and it can be called at any moment something might have
 * changed — after a run, after an alert, and when the person next writes.
 *
 * THE SAME TESTS AS AN INCOMING MESSAGE, made here because this is not a reply:
 * nobody has just proved they hold the phone. Before CRM data goes anywhere the
 * link must be verified, its sign-in still valid (a password reset or "sign out
 * everywhere" ends it), and the number must not have landed on a customer record
 * since. Any doubt and nothing is sent; it is still in the CRM. Nothing is
 * cleared from here: the next message from that phone does that, with its audit.
 *
 * WHATSAPP'S OWN RULE. A business may write freely only within 24 hours of the
 * person's last message; outside that only a message template Meta has approved
 * is delivered. Meta is NOT asked which it is — it usually accepts a late
 * message and fails it afterwards, when it would already be marked as sent
 * here. The link records when the phone last wrote (`lastInboundAt`), and that
 * decides. Outside the 24 hours the workspace's template goes instead — "you
 * have an update", no data in it — at most once a day and not again until they
 * write; their reply opens the 24 hours and this runs again (`windowOpen`),
 * delivering all of it. With no template set, it simply waits.
 *
 * The caller has established the workspace scope and that this person may use
 * the assistant.
 */
export async function sendUpdatesToLinkedPhone(
  tenantId: string,
  userId: string,
  /** shouldStop: a cron's budget. Asked before every message; what is left waits for the next run ("more"). */
  opts: { windowOpen?: boolean; shouldStop?: (reserveMs?: number) => boolean } = {},
): Promise<UpdateDelivery> {
  // Room for one more message: a send may take its whole timeout, then its writes.
  const outOfTime = () => opts.shouldStop?.(UPDATE_SEND_RESERVE_MS) === true;
  try {
    if (!(await assistantWhatsAppOn())) return "not_wanted";
    const link = await basePrisma.assistantPhoneLink.findFirst({
      where: { tenantId, userId, verifiedAt: { not: null }, updatesOnWhatsApp: true },
      select: { id: true, waId: true, sessionVersion: true, nudgedAt: true, nudgeFailedAt: true, lastInboundAt: true },
    });
    if (!link?.waId) return "not_wanted";
    // WAITING: not finished, and not being sent by somebody else right now. A
    // claim that has outlived UPDATE_CLAIM_MS belongs to a run that stopped.
    const waiting = () =>
      basePrisma.assistantTurn.findMany({
        where: {
          tenantId, userId, source: { in: [...PROACTIVE_SOURCES] }, whatsappSentAt: null, createdAt: { gt: new Date(Date.now() - UPDATE_WAIT_MS) },
          OR: [{ whatsappClaimedAt: null }, { whatsappClaimedAt: { lt: new Date(Date.now() - UPDATE_CLAIM_MS) } }],
        },
        orderBy: { createdAt: "asc" },
        take: UPDATE_BATCH,
        select: { id: true, source: true, question: true, answer: true },
      });
    let batch = await waiting();
    if (batch.length === 0) return "nothing";
    const security = await readUserSecurityStateStrict(userId);
    if (!security || link.sessionVersion === null || security.sessionVersion !== link.sessionVersion) return "not_safe";
    const customer = await matchByPhone(link.waId);
    if (customer.contactId || customer.leadId || customer.ambiguous) return "not_safe";

    if (!opts.windowOpen && !replyWindowOpen(link.lastInboundAt)) return await nudgeWithTemplate(tenantId, link);

    // ALL OF IT, a batch at a time until none is left — "tap and everything that
    // was waiting arrives" is the promise. Every pass either finishes updates
    // (they stop being waiting) or returns, so it ends; UPDATE_MAX bounds one call.
    for (let done = 0; batch.length > 0; batch = await waiting()) {
      for (const turn of batch) {
        if (done >= UPDATE_MAX || outOfTime()) return "more";
        const refused = await sendOneUpdate(tenantId, userId, link.waId, turn, outOfTime);
        if (refused === OUT_OF_TIME) return "more";
        // Meta saying "24 hours" although our clock said otherwise: the template is the way through.
        if (refused !== null) return outsideReplyWindow(refused) && !opts.windowOpen ? await nudgeWithTemplate(tenantId, link) : "failed";
        done++;
      }
    }
    return "sent";
  } catch (error) {
    await logError("assistant-whatsapp", "update send threw", error instanceof Error ? error.name : "unknown").catch(() => {});
    return "failed";
  }
}

/**
 * One update, every part of it. Null = it is finished (or another sender has it
 * and will finish it); otherwise why WhatsApp refused.
 *
 * A LONG ANSWER IS SEVERAL MESSAGES, and "sent" means all of them. So it is
 * never marked sent until the last has gone, and how many have gone is written
 * after each one: a send that fails or stops after part one resumes at part two
 * — it neither ends there nor starts over.
 *
 * THE CLAIM EXPIRES. It is taken before anything is sent, so a cron run and an
 * incoming message at the same moment never both send it; and it is a time, not
 * a flag, so a run that stops mid-way leaves the update to the next sender
 * after UPDATE_CLAIM_MS instead of claimed for ever.
 *
 * What is NOT promised: exactly once. A run that stops after WhatsApp took a
 * part and before that was written sends that one part again. A repeated
 * paragraph is the price of never losing one.
 */
async function sendOneUpdate(
  tenantId: string,
  userId: string,
  waId: string,
  turn: { id: string; source: string; question: string; answer: string },
  outOfTime: () => boolean,
): Promise<string | null | typeof OUT_OF_TIME> {
  // The workspace and the person are written out in every call below, not passed
  // in a variable: each one must show for itself whose row it touches.
  const id = turn.id;
  // THIS claim, by its own time. Every write below names it, so a sender that
  // was slow enough to lose its claim to another cannot write over that one's
  // progress — its write matches nothing, and it stops.
  const mine = new Date();
  const claimed = await basePrisma.assistantTurn.updateMany({
    where: { id, tenantId, userId, whatsappSentAt: null, OR: [{ whatsappClaimedAt: null }, { whatsappClaimedAt: { lt: new Date(Date.now() - UPDATE_CLAIM_MS) } }] },
    data: { whatsappClaimedAt: mine },
  });
  if (claimed.count !== 1) return null;
  // Read AFTER the claim: where a sender that stopped had got to.
  const progress = await basePrisma.assistantTurn.findFirst({ where: { id, tenantId, userId }, select: { whatsappPartsSent: true } });
  const parts = splitForWhatsApp(updateText(turn));
  for (let part = Math.min(progress?.whatsappPartsSent ?? 0, parts.length); part < parts.length; part++) {
    // No time left for another message: given back as it stands, for the next run.
    if (outOfTime()) {
      await basePrisma.assistantTurn.updateMany({ where: { id, tenantId, userId, whatsappClaimedAt: mine }, data: { whatsappClaimedAt: null } });
      return OUT_OF_TIME;
    }
    const sent = await sendWhatsAppText(waId, parts[part]);
    if (!sent.ok) {
      // Given back at once, with what has gone kept: the next attempt starts at this part.
      await basePrisma.assistantTurn.updateMany({ where: { id, tenantId, userId, whatsappClaimedAt: mine }, data: { whatsappClaimedAt: null } });
      return sent.error ?? "WhatsApp send failed";
    }
    const noted = await basePrisma.assistantTurn.updateMany({ where: { id, tenantId, userId, whatsappClaimedAt: mine }, data: { whatsappPartsSent: part + 1 } });
    // The claim is no longer ours (this took longer than it lasts): the sender that has it now carries on.
    if (noted.count !== 1) return null;
  }
  await basePrisma.assistantTurn.updateMany({ where: { id, tenantId, userId, whatsappClaimedAt: mine }, data: { whatsappSentAt: new Date(), whatsappClaimedAt: null } });
  return null;
}
const OUT_OF_TIME = Symbol("out of time");

/**
 * The template: it says only that something is waiting, and carries nothing of
 * the CRM's. Once per silence when it GOES. When it does not:
 *  - WhatsApp could not be reached, or was busy: the nudge is given back and
 *    tried again after NUDGE_RETRY_MS — by the next tick, which sweeps for
 *    updates still waiting. An update is not lost to one bad minute.
 *  - Meta will not have the template (no such name, not approved, paused): it
 *    is NOT sent again for NUDGE_EVERY_MS. Repeating a rejected template helps
 *    nobody and costs the number its standing; the owner fixes the setting.
 */
async function nudgeWithTemplate(tenantId: string, link: { id: string; waId: string | null; nudgedAt: Date | null; nudgeFailedAt: Date | null }): Promise<UpdateDelivery> {
  const template = parseUpdateTemplate(await getSetting(ASSISTANT_WHATSAPP_TEMPLATE_KEY).catch(() => null));
  if (!template || !link.waId) return "waiting";
  if (link.nudgedAt && Date.now() - link.nudgedAt.getTime() < NUDGE_EVERY_MS) return "waiting";
  if (link.nudgeFailedAt && Date.now() - link.nudgeFailedAt.getTime() < NUDGE_RETRY_MS) return "waiting";
  // Claimed BEFORE it is sent, on the value read: two ticks cannot both nudge.
  const before = link.nudgedAt;
  const claimed = await basePrisma.assistantPhoneLink.updateMany({ where: { id: link.id, tenantId, nudgedAt: before }, data: { nudgedAt: new Date() } });
  if (claimed.count !== 1) return "waiting";
  // A send that THROWS is a passing failure too: the claim must not outlive it.
  const sent = await sendWhatsAppTemplate(link.waId, template.name, template.language).catch(() => ({ ok: false, error: "Could not reach WhatsApp" }));
  if (sent.ok) {
    if (link.nudgeFailedAt) await basePrisma.assistantPhoneLink.updateMany({ where: { id: link.id, tenantId }, data: { nudgeFailedAt: null } });
    return "nudged";
  }
  if (nudgeFailureMayPass(sent.error)) {
    await basePrisma.assistantPhoneLink.updateMany({ where: { id: link.id, tenantId }, data: { nudgedAt: before, nudgeFailedAt: new Date() } });
    await logError("assistant-whatsapp", "update template could not be sent, will retry").catch(() => {});
  } else {
    await logError("assistant-whatsapp", "update template refused by WhatsApp, not retried today").catch(() => {});
  }
  return "failed";
}

/**
 * The half-hourly look for updates still waiting, in the workspace whose scope
 * this runs in. Without it an update that could not go — WhatsApp down for a
 * minute, a nudge that failed — would wait for the person's next message or
 * their next briefing, and a one-off could reach a day old unsent. Each person
 * is re-checked as on any other path: still a member, still allowed the assistant.
 */
export async function sweepWaitingUpdates(tenantId: string, budget: { shouldStop: (reserveMs?: number) => boolean }): Promise<{ people: number }> {
  // IT SHARES A TICK with the watches and the scheduled questions, and every
  // send waits on WhatsApp. So it asks the budget before each person, and
  // sendUpdatesToLinkedPhone asks again before each message: when time is
  // short it stops, and what is left is here for the next tick.
  if (budget.shouldStop(UPDATE_SEND_RESERVE_MS)) return { people: 0 };
  if (!(await assistantWhatsAppOn())) return { people: 0 };
  const waiting = await basePrisma.assistantTurn.findMany({
    where: { tenantId, source: { in: [...PROACTIVE_SOURCES] }, whatsappSentAt: null, createdAt: { gt: new Date(Date.now() - UPDATE_WAIT_MS) } },
    distinct: ["userId"],
    select: { userId: true },
    take: 200,
  });
  let people = 0;
  for (const { userId } of waiting) {
    if (budget.shouldStop(UPDATE_SEND_RESERVE_MS)) break;
    if (!(await assistantUserFor(userId))) continue;
    await sendUpdatesToLinkedPhone(tenantId, userId, { shouldStop: budget.shouldStop });
    people++;
  }
  return { people };
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

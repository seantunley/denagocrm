import "server-only";
import { basePrisma, prisma } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { botConversationTenantId } from "@/lib/botTenant";
import { currentInboundBotEventId } from "@/lib/botInboundEvent";
import { matchByPhone } from "@/lib/whatsapp";
import { logError } from "@/lib/errorLog";
import { classifyInbound, SCREENING_MODEL } from "./classify";
import {
  SCREENING_POLICY_VERSION, NO_RELATIONSHIP, aiMayQuarantine, decideByRules, extractDomains, normalizeText,
  parseMode, parsePolicy, reasonText, type Relationship, type ScreeningClass, type ScreeningMode, type ScreeningPolicy,
} from "./rules";

export const SCREENING_MODE_SETTING = "INBOUND_SCREENING_MODE";
export const SCREENING_POLICY_SETTING = "INBOUND_SCREENING_POLICY";

export type ScreenedChannel = "whatsapp" | "messenger" | "instagram";

/** Exactly what the normal path needs to admit this message later. Nothing else is kept. */
export type InboundPayload =
  | { via: "whatsapp"; from: string; profileName: string | null; loggedText: string }
  | { via: "dm"; platform: "messenger" | "instagram"; senderId: string; text: string; referral: unknown; attachments: { type: string; url: string }[] };

export type ScreenInput = {
  channel: ScreenedChannel;
  /** Stable channel identity: WhatsApp digits, Messenger PSID, Instagram id. */
  senderId: string;
  providerId: string;
  senderName: string | null;
  kind: "text" | "choice" | "media" | "voice";
  /** What the customer wrote, if anything readable. A tapped button's title counts; a bare photo is "". */
  text: string;
  payload: InboundPayload;
  /** A tapped menu button answers OUR question — it is never classified, only checked against a sender block. */
  isMenuReply?: boolean;
  /** Carried ad attribution: this message would open a lead. */
  wouldOpenLead?: boolean;
};

export type ScreenOutcome =
  /** Carry on exactly as before. `screeningId` is set when a row was written. */
  | { admit: true; screeningId: string | null; classification: ScreeningClass | null }
  /** Stop: the message is held in quarantine and nothing else may happen for it. */
  | { admit: false; screeningId: string };

const ADMIT_UNSCREENED: ScreenOutcome = { admit: true, screeningId: null, classification: null };

export async function screeningSettings(): Promise<{ mode: ScreeningMode; policy: ScreeningPolicy }> {
  const [mode, policy] = await Promise.all([getSetting(SCREENING_MODE_SETTING), getSetting(SCREENING_POLICY_SETTING)]);
  return { mode: parseMode(mode), policy: parsePolicy(policy) };
}

async function senderContact(channel: ScreenedChannel, senderId: string): Promise<{ contactId: string | null; leadId: string | null }> {
  if (channel === "whatsapp") {
    const match = await matchByPhone(senderId);
    return { contactId: match.contactId, leadId: match.leadId };
  }
  const contact = await prisma.contact.findFirst({
    where: channel === "instagram" ? { instagramId: senderId } : { messengerPsid: senderId },
    select: { id: true },
  });
  return { contactId: contact?.id ?? null, leadId: null };
}

const DAY = 24 * 3600 * 1000;
const NOT_BOT = { OR: [{ subject: null }, { NOT: { subject: { startsWith: "🤖" } } }] };

/**
 * What this workspace actually has with the sender. A contact row is not one
 * of the signals — inbound messages create those by themselves.
 *
 * Read through the GUARDED client, like the contact match these ids came from:
 * under enforcement it is bound to the channel's workspace; with enforcement
 * off, customer rows written by a webhook carry no workspace at all, so a
 * query that named one here would find nothing and no customer would ever be
 * recognised.
 */
async function loadRelationship(tenantId: string, channel: ScreenedChannel, senderId: string, who: { contactId: string | null; leadId: string | null }): Promise<Relationship> {
  const { contactId, leadId } = who;
  // "A person on staff wrote to them" has an exact record: a reply sent from the
  // inbox is a delivery-queue row marked origin = staff, keyed by this very
  // sender. Asked first and on its own, because the transcript cannot always
  // tell a person's reply from the chatbot's.
  const staffSent = await basePrisma.botFlowOutbox.findFirst({
    where: { tenantId, channel, key: senderId, origin: "staff", status: "sent", sentAt: { gt: new Date(Date.now() - 90 * DAY) } },
    select: { id: true },
  });
  if (!contactId && !leadId) return { ...NO_RELATIONSHIP, staffReplied: Boolean(staffSent) };
  const owner = [...(contactId ? [{ contactId }] : []), ...(leadId ? [{ leadId }] : [])];
  const [reply, quote, job, drive] = await Promise.all([
    prisma.communication.findFirst({
      where: { type: channel, direction: "outbound", occurredAt: { gt: new Date(Date.now() - 90 * DAY) }, AND: [{ OR: owner }, NOT_BOT] },
      select: { id: true },
    }),
    prisma.quote.findFirst({ where: { status: { in: ["sent", "accepted"] }, OR: owner }, select: { id: true } }),
    contactId ? prisma.jobCard.findFirst({ where: { contactId }, select: { id: true } }) : null,
    contactId ? prisma.testDriveBooking.findFirst({ where: { contactId, status: { notIn: ["cancelled", "no_show"] } }, select: { id: true } }) : null,
  ]);
  return { staffReplied: Boolean(staffSent) || Boolean(reply), activeQuote: Boolean(quote), serviceRecord: Boolean(job), booking: Boolean(drive) };
}

async function recentHistory(channel: ScreenedChannel, who: { contactId: string | null; leadId: string | null }) {
  if (!who.contactId && !who.leadId) return [];
  const rows = await prisma.communication.findMany({
    where: { type: channel, OR: [...(who.contactId ? [{ contactId: who.contactId }] : []), ...(who.leadId ? [{ leadId: who.leadId }] : [])] },
    orderBy: { occurredAt: "desc" },
    take: 6,
    select: { direction: true, body: true },
  });
  return rows.reverse().map((r) => ({ from: r.direction === "inbound" ? ("them" as const) : ("us" as const), text: r.body }));
}

type Decision = {
  quarantine: boolean;
  classification: ScreeningClass;
  uncertain: boolean;
  decidedBy: string;
  reasonCodes: string[];
  reason: string;
  aiUsed: boolean;
  model: string | null;
  aiInputTokens: number | null;
  aiOutputTokens: number | null;
  failure: string | null;
};

const GENUINE: ScreeningClass[] = ["sales_enquiry", "customer_support", "business_approach"];

async function decide(tenantId: string, input: ScreenInput, policy: ScreeningPolicy, who: { contactId: string | null; leadId: string | null }): Promise<Decision> {
  const base = { aiUsed: false, model: null, aiInputTokens: null, aiOutputTokens: null, failure: null };
  const since = (ms: number) => new Date(Date.now() - ms);
  const { channel, senderId } = input;

  const senderRule = await basePrisma.inboundSenderRule.findFirst({
    where: { tenantId, channel, senderId },
    select: { rule: true },
  });
  const rule = senderRule?.rule === "block" ? "block" : senderRule?.rule === "allow" ? "allow" : null;

  // A tapped menu button answers a question WE asked. Only a block stops it.
  if (input.isMenuReply && rule !== "block") {
    return { ...base, quarantine: false, classification: "uncertain", uncertain: false, decidedBy: rule === "allow" ? "sender_allow" : "rule", reasonCodes: ["menu_reply"], reason: "A reply to the chatbot's own menu." };
  }

  // Broad rules are ONLY the ones an owner has switched on. A person's "spam"
  // label on one message is an example and a proposal — it is never read here,
  // so it cannot hold another sender's message by itself.
  const [relationship, patterns, burst] = await Promise.all([
    rule ? NO_RELATIONSHIP : loadRelationship(tenantId, input.channel, input.senderId, who),
    rule ? [] : basePrisma.inboundSpamPattern.findMany({ where: { tenantId, status: "active" }, select: { kind: true, value: true }, take: 500 }),
    rule ? [] : basePrisma.inboundScreening.findMany({ where: { tenantId, channel, senderId, receivedAt: { gt: since(policy.burstWindowSeconds * 1000) } }, select: { body: true }, take: 200 }),
  ]);

  const verdict = decideByRules({
    text: input.text,
    senderRule: rule,
    relationship,
    activeTextPatterns: patterns.filter((p) => p.kind === "text").map((p) => p.value),
    activeDomains: patterns.filter((p) => p.kind === "domain").map((p) => p.value),
    recentFromSender: burst.map((b) => normalizeText(b.body)),
    policy,
  });
  if (verdict.outcome === "quarantine") {
    return { ...base, quarantine: true, classification: verdict.classification, uncertain: false, decidedBy: verdict.decidedBy, reasonCodes: verdict.reasonCodes, reason: verdict.reason };
  }
  if (verdict.outcome === "admit") {
    return { ...base, quarantine: false, classification: verdict.classification, uncertain: verdict.uncertain, decidedBy: verdict.decidedBy, reasonCodes: verdict.reasonCodes, reason: verdict.reason };
  }

  // Undecided. A conversation the filter let through as genuine a moment ago is
  // not re-judged line by line — unless this line brings a link with it.
  if (extractDomains(input.text).length === 0) {
    const earlier = await basePrisma.inboundScreening.findFirst({
      where: { tenantId, channel, senderId, state: "admitted", uncertain: false, classification: { in: GENUINE }, decidedBy: { in: ["ai", "relationship"] }, receivedAt: { gt: since(DAY) } },
      orderBy: { receivedAt: "desc" },
      select: { classification: true },
    });
    if (earlier) {
      return { ...base, quarantine: false, classification: earlier.classification as ScreeningClass, uncertain: false, decidedBy: "rule", reasonCodes: ["recent_genuine_exchange"], reason: "Continues a conversation already let through." };
    }
  }

  // The classifier, inside its budget. Over budget is not a verdict about the sender.
  const [bySender, byWorkspace] = await Promise.all([
    basePrisma.inboundScreening.count({ where: { tenantId, channel, senderId, aiUsed: true, receivedAt: { gt: since(3600 * 1000) } } }),
    basePrisma.inboundScreening.count({ where: { tenantId, aiUsed: true, receivedAt: { gt: since(DAY) } } }),
  ]);
  if (bySender >= policy.aiPerSenderPerHour || byWorkspace >= policy.aiPerWorkspacePerDay) {
    return { ...base, quarantine: false, classification: "uncertain", uncertain: true, decidedBy: "fallback", reasonCodes: ["classifier_budget", ...verdict.reasonCodes], reason: "Not checked — the filter's limit for now was reached.", failure: "budget" };
  }

  const ai = await classifyInbound(
    { channel: input.channel, text: input.text, history: await recentHistory(input.channel, who), knownContact: Boolean(who.contactId) },
    policy,
  );
  if (!ai.ok) {
    // Counted as a call only when one was really made.
    const attempted = ai.failure !== "not_configured";
    return { ...base, aiUsed: attempted, model: attempted ? SCREENING_MODEL : null, quarantine: false, classification: "uncertain", uncertain: true, decidedBy: "fallback", reasonCodes: ["classifier_unavailable", ...verdict.reasonCodes], reason: "The filter could not check this one — let through.", failure: ai.failure };
  }
  const codes = [...ai.verdict.reasonCodes, ...verdict.reasonCodes];
  return {
    aiUsed: true, model: SCREENING_MODEL, aiInputTokens: ai.inputTokens, aiOutputTokens: ai.outputTokens, failure: null,
    quarantine: aiMayQuarantine(ai.verdict, policy),
    classification: ai.verdict.classification,
    uncertain: ai.verdict.uncertain,
    decidedBy: "ai",
    reasonCodes: codes,
    reason: reasonText(codes, "Checked by the filter."),
  };
}

/**
 * After an admitted message has been recorded: note whose it is, so the inbox
 * can show business approaches apart from sales and a later "mark as spam"
 * finds the filter's own answer. Best-effort — the message is already in.
 */
export async function linkScreening(outcome: ScreenOutcome, contactId: string | null | undefined): Promise<void> {
  if (!outcome.admit || !outcome.screeningId || !contactId) return;
  await basePrisma.inboundScreening
    .updateMany({ where: { id: outcome.screeningId, tenantId: botConversationTenantId(), contactId: null }, data: { contactId } })
    .catch(() => {});
}

const isUniqueConflict =(error: unknown) => (error as { code?: string } | null)?.code === "P2002";

/**
 * THE screening stage. Called by the webhook routes after the signature check,
 * the workspace has been resolved, the event has been claimed and (on WhatsApp)
 * the sender is known not to be staff talking to DAX — and before anything is
 * recorded, created, pushed or answered.
 *
 * It never throws and never loses a message: if anything in here fails, the
 * message carries on through the normal workflow, with the failure in the
 * system log. Only a decision that was reached AND written down can stop one.
 */
export async function screenInbound(input: ScreenInput): Promise<ScreenOutcome> {
  const started = Date.now();
  try {
    const { mode, policy } = await screeningSettings();
    if (mode === "off" || !input.senderId || !input.providerId) return ADMIT_UNSCREENED;
    const tenantId = botConversationTenantId();
    const { channel, providerId } = input;

    // A redelivery of a message already judged: same answer, no second look, no second charge.
    const seen = await basePrisma.inboundScreening.findFirst({ where: { tenantId, channel, providerId }, select: { id: true, state: true, classification: true } });
    if (seen) {
      return seen.state === "admitted"
        ? { admit: true, screeningId: seen.id, classification: seen.classification as ScreeningClass }
        : { admit: false, screeningId: seen.id };
    }

    const who = await senderContact(input.channel, input.senderId);
    const d = await decide(tenantId, input, policy, who);
    const hold = d.quarantine && mode === "quarantine";
    const withheld = d.quarantine
      ? { staffPush: true, botRun: true, newContact: !who.contactId && !who.leadId, newLead: Boolean(input.wouldOpenLead) }
      : null;
    try {
      const row = await basePrisma.inboundScreening.create({
        data: {
          tenantId, channel: input.channel, senderId: input.senderId, providerId: input.providerId,
          eventId: currentInboundBotEventId(), senderName: input.senderName?.slice(0, 120) ?? null,
          kind: input.kind, body: input.text.slice(0, 4000), payload: input.payload as object,
          classification: d.classification, uncertain: d.uncertain, decidedBy: d.decidedBy,
          reasonCodes: d.reasonCodes.slice(0, 8), reason: d.reason, policyVersion: SCREENING_POLICY_VERSION,
          model: d.model, aiUsed: d.aiUsed, aiInputTokens: d.aiInputTokens, aiOutputTokens: d.aiOutputTokens,
          latencyMs: Date.now() - started, failure: d.failure, mode,
          state: hold ? "quarantined" : "admitted",
          suppressed: withheld ?? undefined,
          contactId: hold ? null : who.contactId,
        },
        select: { id: true },
      });
      return hold ? { admit: false, screeningId: row.id } : { admit: true, screeningId: row.id, classification: d.classification };
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      // Lost a race with a concurrent delivery of the same message: its verdict stands.
      const other = await basePrisma.inboundScreening.findFirst({ where: { tenantId, channel, providerId }, select: { id: true, state: true, classification: true } });
      if (other && other.state !== "admitted") return { admit: false, screeningId: other.id };
      return { admit: true, screeningId: other?.id ?? null, classification: (other?.classification as ScreeningClass) ?? null };
    }
  } catch (error) {
    await logError("inbound-screening", error).catch(() => {});
    return ADMIT_UNSCREENED;
  }
}

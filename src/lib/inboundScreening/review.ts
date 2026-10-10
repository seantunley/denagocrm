import "server-only";
import { basePrisma, prisma } from "@/lib/db";
import { withInboundBotEvent } from "@/lib/botInboundEvent";
import { recordInboundWhatsApp } from "@/lib/whatsapp";
import { recordInboundDm } from "@/lib/messenger";
import { SCREENING_POLICY_VERSION, extractDomains, normalizeText, parsePolicy, type ScreeningMode } from "./rules";
import { SCREENING_POLICY_SETTING, type InboundPayload } from "./screen";
import { getSetting } from "@/lib/settings";

/**
 * What a person does about screened messages. Every function takes the acting
 * workspace and names it in every statement: a caller who may review spam is
 * not thereby the owner of the row whose id they posted.
 */

export class ReviewRefusal extends Error {}
const refuse = (message: string): never => { throw new ReviewRefusal(message); };

export type Reviewer = { id: string; name: string };

/**
 * "Not spam — restore": admit the original message, exactly once.
 *
 * The row is claimed first (quarantined → restoring) with a counted update, so
 * two people clicking at once cannot both admit it. The message then takes the
 * NORMAL recording path — same contact matching, same conversation, same
 * transcript dedupe key as the day it arrived (its ledger event) — so a second
 * admission by any route is refused by the transcript itself.
 *
 * Deliberately NOT replayed: the chatbot. Its reply would answer a question that
 * may be days old; a restored message waits for a person instead, and nobody is
 * buzzed about it because a person is looking at it right now.
 */
export async function restoreScreening(tenantId: string, id: string, by: Reviewer): Promise<{ contactId: string | null; leadId: string | null }> {
  const row = await basePrisma.inboundScreening.findFirst({ where: { id, tenantId } });
  if (!row) refuse("That message is no longer here.");
  if (row!.state !== "quarantined") refuse(row!.state === "restored" ? "That message was already restored." : "That message is not in quarantine.");

  // Today's policy, not the day it arrived: a sender blocked since stays out.
  const rule = await basePrisma.inboundSenderRule.findFirst({
    where: { tenantId, channel: row!.channel, senderId: row!.senderId },
    select: { rule: true },
  });
  if (rule?.rule === "block") refuse("This sender is blocked. Unblock them first, then restore the message.");

  const claimed = await basePrisma.inboundScreening.updateMany({ where: { id, tenantId, state: "quarantined" }, data: { state: "restoring" } });
  if (claimed.count !== 1) refuse("Someone else just restored that message.");

  try {
    const payload = row!.payload as unknown as InboundPayload;
    const admitted = await withInboundBotEvent({ rowId: row!.eventId, leaseAttempt: null }, async () =>
      payload.via === "whatsapp"
        ? recordInboundWhatsApp(payload.from, payload.profileName, payload.loggedText, row!.providerId, { quiet: true })
        : recordInboundDm(payload.platform, payload.senderId, payload.text, payload.referral as never, payload.attachments ?? [], row!.providerId, { quiet: true }),
    );
    // File it where it belongs in time: the day it was sent, not the day it was restored.
    if (row!.eventId) {
      // The guarded client: the row just written belongs to the acting workspace.
      await prisma.communication.updateMany({
        where: { dedupeKey: { startsWith: `inbound:${row!.eventId}` } },
        data: { occurredAt: row!.receivedAt },
      });
    }
    await basePrisma.inboundScreening.updateMany({
      where: { id, tenantId, state: "restoring" },
      data: { state: "restored", restoredAt: new Date(), restoredById: by.id, staffLabel: "not_spam", labelledById: by.id, labelledAt: new Date(), contactId: admitted?.contactId ?? null },
    });
    return { contactId: admitted?.contactId ?? null, leadId: admitted?.leadId ?? null };
  } catch (error) {
    // Nothing is lost: back into quarantine, to be tried again.
    await basePrisma.inboundScreening.updateMany({ where: { id, tenantId, state: "restoring" }, data: { state: "quarantined" } }).catch(() => {});
    throw error;
  }
}

/** A standing decision about one sender on one channel. `null` removes it. */
export async function setSenderRule(tenantId: string, channel: string, senderId: string, rule: "allow" | "block" | null, by: Reviewer, senderName?: string | null): Promise<void> {
  if (!senderId || !["whatsapp", "messenger", "instagram"].includes(channel)) refuse("That sender can't be given a rule.");
  const where = { tenantId_channel_senderId: { tenantId, channel, senderId } };
  if (rule === null) {
    await basePrisma.inboundSenderRule.deleteMany({ where: { tenantId, channel, senderId } });
    return;
  }
  await basePrisma.inboundSenderRule.upsert({
    where,
    create: { tenantId, channel, senderId, rule, senderName: senderName?.slice(0, 120) ?? null, createdById: by.id },
    update: { rule, createdById: by.id, ...(senderName ? { senderName: senderName.slice(0, 120) } : {}) },
  });
}

/**
 * A person says "this is spam". It is recorded as a labelled example — with
 * the filter's own answer, its reason and the policy version still on the row —
 * and it PROPOSES broad rules; it never creates an active one. One correction
 * must not be able to silence a wording or a website for every sender.
 */
export async function labelSpam(tenantId: string, ids: string[], by: Reviewer): Promise<number> {
  const rows = await basePrisma.inboundScreening.findMany({ where: { tenantId, id: { in: ids.slice(0, 200) } }, select: { id: true, body: true } });
  if (rows.length === 0) return 0;
  await basePrisma.inboundScreening.updateMany({
    where: { tenantId, id: { in: rows.map((r) => r.id) } },
    data: { staffLabel: "spam", labelledById: by.id, labelledAt: new Date() },
  });
  const policy = parsePolicy(await getSetting(SCREENING_POLICY_SETTING));
  for (const row of rows) {
    const normalized = normalizeText(row.body);
    const proposals = [
      ...(normalized.split(" ").filter(Boolean).length >= policy.repeatMinWords ? [{ kind: "text", value: normalized }] : []),
      ...extractDomains(row.body).map((domain) => ({ kind: "domain", value: domain })),
    ];
    for (const p of proposals) {
      await basePrisma.inboundSpamPattern.upsert({
        where: { tenantId_kind_value: { tenantId, kind: p.kind, value: p.value } },
        create: { tenantId, kind: p.kind, value: p.value, status: "proposed", sourceId: row.id, createdById: by.id, hits: 1 },
        update: { hits: { increment: 1 } },
      });
    }
  }
  return rows.length;
}

/** Owner only (the action checks): switch a proposed broad rule on, or off again. */
export async function setPatternStatus(tenantId: string, id: string, status: "active" | "disabled", by: Reviewer): Promise<void> {
  const done = await basePrisma.inboundSpamPattern.updateMany({ where: { id, tenantId }, data: { status, decidedById: by.id } });
  if (done.count !== 1) refuse("That rule is no longer here.");
}

/**
 * Spam the filter missed: a conversation already in the inbox that a person
 * marks as spam. Labels what the filter recorded for that sender (or writes a
 * labelled example if it recorded nothing) and archives the thread. It does
 * not block the sender — that is a separate decision.
 */
export async function markThreadSpam(tenantId: string, contactId: string, channel: string, by: Reviewer): Promise<number> {
  // The customer and their messages are read through the guarded client (bound to
  // the acting workspace under enforcement). The CALLER proves the row is theirs
  // in both modes — the action asks canAccessContact before it gets here.
  const contact = await prisma.contact.findFirst({ where: { id: contactId }, select: { id: true, firstName: true, lastName: true, whatsapp: true, phone: true, messengerPsid: true, instagramId: true } });
  if (!contact) refuse("That customer is no longer here.");
  const senderId = channel === "whatsapp" ? (contact!.whatsapp ?? contact!.phone ?? "").replace(/\D/g, "") : channel === "instagram" ? contact!.instagramId ?? "" : contact!.messengerPsid ?? "";
  let rows = await basePrisma.inboundScreening.findMany({
    where: { tenantId, channel, state: "admitted", staffLabel: null, OR: [{ contactId }, ...(senderId ? [{ senderId }] : [])] },
    orderBy: { receivedAt: "desc" }, take: 20, select: { id: true },
  });
  if (rows.length === 0) {
    // Screening was off, or had not seen this sender: keep the newest message as the example.
    const latest = await prisma.communication.findFirst({ where: { contactId, type: channel, direction: "inbound" }, orderBy: { occurredAt: "desc" }, select: { id: true, body: true, occurredAt: true } });
    if (!latest) refuse("There is no incoming message in that conversation.");
    const made = await basePrisma.inboundScreening.create({
      data: {
        tenantId, channel, senderId: senderId || `contact:${contactId}`, providerId: `staff:${latest!.id}`, senderName: `${contact!.firstName} ${contact!.lastName ?? ""}`.trim(),
        kind: "text", body: latest!.body.slice(0, 4000), payload: {}, classification: "spam", decidedBy: "staff", reasonCodes: ["marked_by_staff"],
        reason: "Marked as spam by a person.", policyVersion: SCREENING_POLICY_VERSION, mode: "off", state: "admitted", contactId, receivedAt: latest!.occurredAt,
      },
      select: { id: true },
    });
    rows = [made];
  }
  const labelled = await labelSpam(tenantId, rows.map((r) => r.id), by);
  await prisma.communication.updateMany({ where: { contactId, type: channel }, data: { archivedAt: new Date() } });
  return labelled;
}

/* ── numbers ──────────────────────────────────────────────────────────── */

export type ScreeningMetrics = {
  days: number;
  screened: number;
  quarantined: number;
  observedWouldQuarantine: number;
  restoredAsGenuine: number;
  missedMarkedByStaff: number;
  reviewed: number;
  suppressedPushes: number;
  suppressedBotRuns: number;
  suppressedNewContacts: number;
  suppressedNewLeads: number;
  aiCalls: number;
  aiInputTokens: number;
  aiOutputTokens: number;
  failures: number;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
};

/** Counts over a period — what happened, not what it was worth. Nothing here is an estimate. */
export async function screeningMetrics(tenantId: string, days = 30): Promise<ScreeningMetrics> {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const [row] = await basePrisma.$queryRaw<Array<Record<string, number | null>>>`
    SELECT
      count(*)::int AS screened,
      count(*) FILTER (WHERE "state" IN ('quarantined','restoring','restored'))::int AS quarantined,
      count(*) FILTER (WHERE "state" = 'admitted' AND "mode" = 'observe' AND "suppressed" IS NOT NULL)::int AS observed,
      count(*) FILTER (WHERE "state" = 'restored')::int AS restored,
      count(*) FILTER (WHERE "state" = 'admitted' AND "staffLabel" = 'spam')::int AS missed,
      count(*) FILTER (WHERE "staffLabel" IS NOT NULL)::int AS reviewed,
      count(*) FILTER (WHERE "state" IN ('quarantined','restoring','restored') AND ("suppressed"->>'staffPush') = 'true')::int AS pushes,
      count(*) FILTER (WHERE "state" IN ('quarantined','restoring','restored') AND ("suppressed"->>'botRun') = 'true')::int AS bot_runs,
      count(*) FILTER (WHERE "state" IN ('quarantined','restoring') AND ("suppressed"->>'newContact') = 'true')::int AS contacts,
      count(*) FILTER (WHERE "state" IN ('quarantined','restoring') AND ("suppressed"->>'newLead') = 'true')::int AS leads,
      count(*) FILTER (WHERE "aiUsed")::int AS ai_calls,
      coalesce(sum("aiInputTokens"), 0)::int AS ai_in,
      coalesce(sum("aiOutputTokens"), 0)::int AS ai_out,
      count(*) FILTER (WHERE "failure" IS NOT NULL AND "failure" <> 'budget')::int AS failures,
      (percentile_cont(0.5) WITHIN GROUP (ORDER BY "latencyMs") FILTER (WHERE "decidedBy" <> 'staff'))::int AS median,
      (percentile_cont(0.95) WITHIN GROUP (ORDER BY "latencyMs") FILTER (WHERE "decidedBy" <> 'staff'))::int AS p95
    FROM "InboundScreening"
    WHERE "tenantId" = ${tenantId} AND "receivedAt" > ${since} AND "decidedBy" <> 'staff'
  `;
  const n = (k: string) => Number(row?.[k] ?? 0);
  return {
    days, screened: n("screened"), quarantined: n("quarantined"), observedWouldQuarantine: n("observed"), restoredAsGenuine: n("restored"),
    missedMarkedByStaff: await basePrisma.inboundScreening.count({ where: { tenantId, state: "admitted", staffLabel: "spam", labelledAt: { gt: since } } }),
    reviewed: n("reviewed"), suppressedPushes: n("pushes"), suppressedBotRuns: n("bot_runs"), suppressedNewContacts: n("contacts"), suppressedNewLeads: n("leads"),
    aiCalls: n("ai_calls"), aiInputTokens: n("ai_in"), aiOutputTokens: n("ai_out"), failures: n("failures"),
    medianLatencyMs: row?.median ?? null, p95LatencyMs: row?.p95 ?? null,
  };
}

export type { ScreeningMode };

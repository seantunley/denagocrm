import "server-only";
import { prisma } from "./db";
import { logError } from "./errorLog";
import { logAudit } from "./audit";
import { assistantUserFor } from "./assistantUser";
import { currentTenantScope } from "./tenantScope";
import { sendPushToAll } from "./push";
import { getSetting } from "./settings";
import { ASSISTANT_PROFILE_KEY, parseProfile } from "./assistantSoul";
import {
  canAccessLead,
  canAccessQuote,
  getAccessibleLeadIds,
  getAccessibleQuoteIds,
  hasAnyPermission,
  type PermissionUser,
} from "./permissions";
import { accessibleTestDriveWhere } from "./testDriveAccess";
import { contactActivityWhere, contactCommunicationWhere, latestContactAt } from "./customerContact";
import { isModuleEnabled } from "./modules/enabled";
import { contactName } from "./format";
import { ownedWriteTenantId } from "./tenantWrite";
import {
  MAX_ACTIVE_WATCHES,
  ONE_SHOT_KINDS,
  WATCH_GONE_NOTE,
  describeWatch,
  firedChanged,
  nextFiredState,
  watchInput,
  watchNotification,
  type WatchHit,
  type WatchKind,
} from "./assistantWatchRules";
import type { CronSliceContext } from "./tenantCron";

/*
 * Watches, run: the cron checks each active watch with plain queries (no
 * ChatGPT), as the person who set it, and tells only them. The pure rules —
 * what a watch is, when a record is news, what the note says — live in
 * assistantWatchRules.ts.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Stop starting checks with less than this left: a check is a handful of queries. */
const WATCH_CHECK_RESERVE_MS = 15_000;

/**
 * A watch checked in the last 20 minutes is skipped. The cron beats every 30, so
 * every watch is checked once per tick — and a second, overlapping tick finds
 * nothing left to do.
 */
const RECHECK_AFTER_MS = 20 * 60 * 1000;

/**
 * ponytail: up to 100 watches per workspace per tick, oldest-checked first —
 * at ten per person that is ten people; the rest are checked next tick. Raise
 * it (or page through) when a workspace has more people watching than that.
 */
const WATCH_BATCH = 100;

/**
 * Records read per check. ponytail: "any lead / any quote" watches look at the
 * newest 200 that match; past that, a quieter, older record isn't seen. Fine
 * for a dealer's open pipeline; page through when that stops being true.
 */
const CANDIDATES = 200;

/** A completed test drive older than this is history, not a follow-up to chase. */
const TEST_DRIVE_LOOKBACK_MS = 7 * DAY;

/** Live in the signing hub — sent and not finished (its quote's own status stays "draft"). */
const LIVE_SIGNING = ["sent", "viewed", "in_progress"];

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

type Watch = {
  id: string;
  tenantId: string;
  userId: string;
  kind: string;
  leadId: string | null;
  quoteId: string | null;
  product: string | null;
  thresholdHours: number | null;
  thresholdDays: number | null;
  label: string;
  fired: unknown;
  lastCheckedAt: Date | null;
};

type Hit = WatchHit & { id: string };
/** "gone": a one-record watch whose record is deleted or no longer the person's to open. */
type Check = Hit[] | "gone";

const QUOTE_SELECT = {
  id: true,
  number: true,
  viewedAt: true,
  lead: { select: { name: true } },
  contact: { select: { firstName: true, lastName: true } },
} as const;

type QuoteRow = { id: string; number: number; viewedAt: Date | null; lead: { name: string } | null; contact: { firstName: string; lastName: string | null } | null };

const customerOf = (q: QuoteRow) => (q.contact ? contactName(q.contact) : q.lead?.name ?? null);
const quoteHit = (q: QuoteRow, detail?: string): Hit => ({ id: q.id, ref: `Q-${q.number}`, customer: customerOf(q), detail });
const saDate = (d: Date) =>
  d.toLocaleDateString("en-ZA", { timeZone: "Africa/Johannesburg", weekday: "short", day: "numeric", month: "short" });

/**
 * Has the customer opened it? Quote.viewedAt (the quote's own link), or — for a
 * quote sent through the signing hub, which keeps its own status "draft" and no
 * viewedAt — a signer on a request that went out has viewed it.
 *
 * Limitation: any recipient with role "signer" counts. A staff member set up as
 * a co-signer opening the envelope would read as the customer opening it; the
 * hub has no "this signer is the customer" flag to tell them apart.
 */
async function quoteOpened(tenantId: string, quote: { id: string; viewedAt: Date | null }): Promise<boolean> {
  if (quote.viewedAt) return true;
  const hub = await prisma.signatureRequest.findFirst({
    where: {
      tenantId,
      quoteId: quote.id,
      deletedAt: null,
      status: { notIn: ["draft", "voided"] },
      recipients: { some: { role: "signer", viewedAt: { not: null } } },
    },
    select: { id: true },
  });
  return Boolean(hub);
}

/* ── The five checks. Each runs AS the person: their access, at run time. ── */

async function checkQuoteViewed(user: PermissionUser, tenantId: string, w: Watch): Promise<Check> {
  if (!w.quoteId || !(await canAccessQuote(user, w.quoteId))) return "gone";
  const quote = await prisma.quote.findFirst({ where: { id: w.quoteId, tenantId, deletedAt: null }, select: QUOTE_SELECT });
  if (!quote) return "gone";
  return (await quoteOpened(tenantId, quote)) ? [quoteHit(quote)] : [];
}

async function checkQuoteUnsigned(user: PermissionUser, tenantId: string, w: Watch, now: Date): Promise<Check> {
  const cutoff = new Date(now.getTime() - (w.thresholdHours ?? 48) * HOUR);
  let ids: string[] | null;
  if (w.quoteId) {
    if (!(await canAccessQuote(user, w.quoteId))) return "gone";
    ids = [w.quoteId];
  } else {
    ids = await getAccessibleQuoteIds(user);
  }
  if (ids && !ids.length) return [];
  // Opened in the signing hub at least N hours ago.
  const hub = await prisma.signatureRequest.findMany({
    where: {
      tenantId,
      deletedAt: null,
      status: { in: LIVE_SIGNING },
      quoteId: ids === null ? { not: null } : { in: ids },
      recipients: { some: { role: "signer", viewedAt: { lte: cutoff } } },
    },
    take: CANDIDATES,
    select: { quoteId: true },
  });
  const quotes = await prisma.quote.findMany({
    where: {
      tenantId,
      deletedAt: null,
      supersededAt: null,
      signedAt: null,
      declinedAt: null,
      status: { in: ["draft", "sent"] },
      ...(ids === null ? {} : { id: { in: ids } }),
      // Inside AND: a top-level `id` here would replace the access filter above.
      AND: [{ OR: [{ viewedAt: { lte: cutoff } }, { id: { in: hub.flatMap((r) => (r.quoteId ? [r.quoteId] : [])) } }] }],
    },
    orderBy: { createdAt: "desc" },
    take: CANDIDATES,
    select: QUOTE_SELECT,
  });
  if (!quotes.length) return [];
  // Signed or declined in the hub: the quote's own signedAt/declinedAt can stay empty.
  const settled = await prisma.signatureRequest.findMany({
    where: { tenantId, deletedAt: null, quoteId: { in: quotes.map((q) => q.id) }, status: { in: ["completed", "declined", "rejected"] } },
    select: { quoteId: true },
  });
  const done = new Set(settled.map((r) => r.quoteId));
  return quotes.filter((q) => !done.has(q.id)).map((q) => quoteHit(q));
}

async function checkLeadQuiet(user: PermissionUser, tenantId: string, w: Watch, now: Date): Promise<Check> {
  const cutoff = new Date(now.getTime() - (w.thresholdDays ?? 7) * DAY);
  let ids: string[] | null;
  if (w.leadId) {
    if (!(await canAccessLead(user, w.leadId))) return "gone";
    ids = [w.leadId];
  } else {
    ids = await getAccessibleLeadIds(user);
  }
  if (ids && !ids.length) return [];
  const leads = await prisma.lead.findMany({
    where: {
      tenantId,
      deletedAt: null,
      status: "open",
      // A lead that only arrived yesterday hasn't gone quiet for a week.
      createdAt: { lt: cutoff },
      ...(ids === null ? {} : { id: { in: ids } }),
      ...(w.product ? { product: { name: { contains: w.product, mode: "insensitive" as const } } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: CANDIDATES,
    select: {
      id: true,
      title: true,
      name: true,
      // Real contact only (customerContact.ts) — the same rule as DAX's "gone quiet".
      communications: { where: contactCommunicationWhere, orderBy: { occurredAt: "desc" }, take: 1, select: { type: true, occurredAt: true } },
      activities: { where: contactActivityWhere, orderBy: { doneAt: "desc" }, take: 1, select: { type: true, doneAt: true, availabilityBlock: true } },
    },
  });
  const hits: Hit[] = [];
  for (const lead of leads) {
    const last = latestContactAt(lead.communications, lead.activities);
    if (last && last >= cutoff) continue;
    const detail = last ? `last contact ${Math.floor((now.getTime() - last.getTime()) / DAY)} days ago` : "never contacted";
    hits.push({ id: lead.id, ref: lead.title, customer: lead.name, detail });
  }
  return hits;
}

async function checkTestDriveNoFollowUp(user: PermissionUser, tenantId: string, w: Watch, now: Date): Promise<Check> {
  if (!(await isModuleEnabled("automotive"))) return [];
  if (!(await hasAnyPermission(user, "activities.view", "activities.manage"))) return [];
  const cutoff = new Date(now.getTime() - (w.thresholdHours ?? 24) * HOUR);
  const bookings = await prisma.testDriveBooking.findMany({
    where: {
      tenantId,
      deletedAt: null,
      status: "completed",
      leadId: { not: null },
      actualReturnAt: { lte: cutoff, gte: new Date(cutoff.getTime() - TEST_DRIVE_LOOKBACK_MS) },
      ...(await accessibleTestDriveWhere(user)),
    },
    orderBy: { actualReturnAt: "desc" },
    take: CANDIDATES,
    select: { id: true, reference: true, leadId: true },
  });
  const leadIds = [...new Set(bookings.flatMap((b) => (b.leadId ? [b.leadId] : [])))];
  if (!leadIds.length) return [];
  const planned = await prisma.activity.findMany({
    where: { tenantId, leadId: { in: leadIds }, status: "planned" },
    distinct: ["leadId"],
    select: { leadId: true },
  });
  const followedUp = new Set(planned.map((a) => a.leadId));
  // The booking is theirs to open; the lead's name only if the lead is too.
  const visible = await getAccessibleLeadIds(user);
  const named = await prisma.lead.findMany({
    where: { tenantId, id: { in: visible === null ? leadIds : leadIds.filter((id) => visible.includes(id)) } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(named.map((l) => [l.id, l.name]));
  return bookings
    .filter((b) => b.leadId && !followedUp.has(b.leadId))
    .map((b) => ({ id: b.id, ref: `Test drive ${b.reference}`, customer: b.leadId ? nameOf.get(b.leadId) ?? null : null }));
}

async function checkDeliveryDepositDue(user: PermissionUser, tenantId: string, w: Watch, now: Date): Promise<Check> {
  // /deliveries is part of the automotive module, behind its own permission.
  if (!(await isModuleEnabled("automotive"))) return [];
  if (!(await hasAnyPermission(user, "deliveries.view", "deliveries.manage"))) return [];
  const ids = await getAccessibleQuoteIds(user);
  if (ids && !ids.length) return [];
  const quotes = await prisma.quote.findMany({
    where: {
      tenantId,
      status: "accepted",
      supersededAt: null,
      deletedAt: null,
      deliveredAt: null,
      depositPaidAt: null,
      // From a day back: a delivery saved as a date reads as midnight, and today's still counts.
      deliveryScheduledFor: { gte: new Date(now.getTime() - DAY), lte: new Date(now.getTime() + (w.thresholdHours ?? 48) * HOUR) },
      ...(ids === null ? {} : { id: { in: ids } }),
    },
    orderBy: { deliveryScheduledFor: "asc" },
    take: CANDIDATES,
    select: { ...QUOTE_SELECT, deliveryScheduledFor: true },
  });
  return quotes.map((q) => quoteHit(q, q.deliveryScheduledFor ? `delivery ${saDate(q.deliveryScheduledFor)}` : undefined));
}

function check(user: PermissionUser, tenantId: string, w: Watch, now: Date): Promise<Check> {
  switch (w.kind as WatchKind) {
    case "quote_viewed": return checkQuoteViewed(user, tenantId, w);
    case "quote_unsigned": return checkQuoteUnsigned(user, tenantId, w, now);
    case "lead_quiet": return checkLeadQuiet(user, tenantId, w, now);
    case "test_drive_no_follow_up": return checkTestDriveNoFollowUp(user, tenantId, w, now);
    case "delivery_deposit_due": return checkDeliveryDepositDue(user, tenantId, w, now);
    default: return Promise.resolve("gone");
  }
}

/**
 * Run `write` only while the person has a free slot (fewer than
 * MAX_ACTIVE_WATCHES active), under a per-person lock held to the end of the
 * transaction — so two Confirm clicks, or a Confirm and a Resume, can't both
 * pass the count. null = at the cap, nothing written.
 */
export async function withWatchSlot<T>(tenantId: string, userId: string, write: (tx: Tx) => Promise<T>): Promise<T | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`assistant-watches:${userId}`})::bigint)`;
    if ((await tx.assistantWatch.count({ where: { tenantId, userId, active: true } })) >= MAX_ACTIVE_WATCHES) return null;
    return write(tx);
  });
}

export type CreateWatchResult = { ok: true; id: string; label: string } | { ok: false; error: string };

/**
 * Save a watch the person confirmed (DAX proposed it as a card). The caller has
 * already checked they may use the assistant, inside their acting scope.
 *
 * Checked here, because the card's fields came from the model: the shape per
 * kind, that the quote or lead is one THEY can open (canAccessQuote /
 * canAccessLead), the module and permission an automotive watch needs, and the
 * per-person cap under a lock. The label is written from the record itself.
 */
export async function createWatchForUser(user: PermissionUser, raw: unknown): Promise<CreateWatchResult> {
  const parsed = watchInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "That watch isn't set up right — ask me again in other words." };
  const input = parsed.data;
  const tenantId = ownedWriteTenantId();
  const names: { quote?: string; customer?: string | null; lead?: string } = {};

  let quoteId = input.quoteId ?? null;
  if (quoteId) {
    // The model sees quote NUMBERS ("Q-1042"), so either form is accepted.
    const number = /^Q-?(\d+)$/i.exec(quoteId)?.[1];
    const quote = await prisma.quote.findFirst({
      where: { tenantId, deletedAt: null, ...(number ? { number: Number(number) } : { id: quoteId }) },
      select: QUOTE_SELECT,
    });
    if (!quote || !(await canAccessQuote(user, quote.id))) return { ok: false, error: "I can't find that quote among the ones you can open." };
    if (input.kind === "quote_viewed" && (await quoteOpened(tenantId, quote))) {
      return { ok: false, error: `Q-${quote.number} has already been opened — there's nothing to wait for.` };
    }
    quoteId = quote.id;
    names.quote = `Q-${quote.number}`;
    names.customer = customerOf(quote);
  }

  const leadId = input.leadId ?? null;
  if (leadId) {
    const lead = (await canAccessLead(user, leadId))
      ? await prisma.lead.findFirst({ where: { id: leadId, tenantId, deletedAt: null }, select: { name: true, title: true } })
      : null;
    if (!lead) return { ok: false, error: "I can't find that lead among the ones you can open." };
    names.lead = lead.name || lead.title;
  }

  if (input.kind === "test_drive_no_follow_up" || input.kind === "delivery_deposit_due") {
    if (!(await isModuleEnabled("automotive"))) return { ok: false, error: "Test drives and deliveries aren't switched on for this workspace." };
    const allowed = input.kind === "test_drive_no_follow_up"
      ? await hasAnyPermission(user, "activities.view", "activities.manage")
      : await hasAnyPermission(user, "deliveries.view", "deliveries.manage");
    if (!allowed) return { ok: false, error: "You don't have access to that, so I can't watch it for you." };
  }

  const label = describeWatch({ ...input, quoteId, leadId }, names);
  const created = await withWatchSlot(tenantId, user.id, (tx) =>
    tx.assistantWatch.create({
      data: {
        tenantId,
        userId: user.id,
        kind: input.kind,
        leadId,
        quoteId,
        product: input.product ?? null,
        thresholdHours: input.thresholdHours ?? null,
        thresholdDays: input.thresholdDays ?? null,
        label,
      },
      select: { id: true },
    }),
  );
  if (!created) return { ok: false, error: `You already have ${MAX_ACTIVE_WATCHES} watches running — pause or delete one on the Ask page first.` };
  // The kind only — the label carries a customer's name.
  await logAudit({
    action: "assistant.watch_created",
    summary: `Set up an assistant watch (${input.kind.replace(/_/g, " ")})`,
    user,
    entityType: "AssistantWatch",
    entityId: created.id,
  });
  return { ok: true, id: created.id, label };
}

/**
 * Check the active watches in the workspace whose scope the cron has already
 * entered (runCronPerTenant), least recently checked first.
 *
 * Safe against overlapping ticks: each watch is CLAIMED before it is checked —
 * one conditional update that moves lastCheckedAt on only if it still holds the
 * value read here — and its result is written only while that claim still
 * stands, in the same transaction as the note. Two runners never tell the
 * person twice.
 *
 * Runs AS the person, re-checked at run time (assistantUserFor): left the
 * workspace, lost the assistant permission, module switched off → the watch is
 * switched off. Every check uses their own visibility, so a watch never names a
 * record they can't open. The note lands in their own thread; the push says
 * only that something happened — no names on a lock screen.
 *
 * ONE WORKSPACE, NAMED: only inside a real tenant scope, and that tenant is on
 * every read and write on top of the db guard and RLS.
 */
export async function runAssistantWatches(budget: CronSliceContext): Promise<{ checked: number; fired: number }> {
  const scope = currentTenantScope();
  if (!scope || scope.system || !scope.tenantId) return { checked: 0, fired: 0 };
  const tenantId = scope.tenantId;

  const watches = await prisma.assistantWatch.findMany({
    where: {
      tenantId,
      active: true,
      OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(Date.now() - RECHECK_AFTER_MS) } }],
    },
    orderBy: { lastCheckedAt: { sort: "asc", nulls: "first" } },
    take: WATCH_BATCH,
    select: {
      id: true, tenantId: true, userId: true, kind: true, leadId: true, quoteId: true, product: true,
      thresholdHours: true, thresholdDays: true, label: true, fired: true, lastCheckedAt: true,
    },
  });

  let checked = 0;
  let fired = 0;
  let assistantName: string | null = null;
  for (const watch of watches) {
    if (budget.shouldStop(WATCH_CHECK_RESERVE_MS)) break;
    if (watch.tenantId !== tenantId) continue;

    // WHO they are, before the claim. A failure to read it touches nothing —
    // tried again next tick. Only a definite "no longer allowed" switches it off.
    let user: Awaited<ReturnType<typeof assistantUserFor>>;
    try {
      user = await assistantUserFor(watch.userId);
    } catch (error) {
      await logError("assistant-watch", "couldn't check the person for a watch", error instanceof Error ? error.name : "unknown");
      continue;
    }
    if (!user || user.id !== watch.userId) {
      const off = await prisma.assistantWatch.updateMany({
        where: { id: watch.id, tenantId, active: true, lastCheckedAt: watch.lastCheckedAt },
        data: { active: false },
      });
      if (off.count) {
        await logAudit({
          action: "assistant.watch_switched_off",
          summary: "Switched off an assistant watch: the person it runs as no longer has access to the assistant",
          userName: "Assistant (watches)",
          entityType: "AssistantWatch",
          entityId: watch.id,
        });
      }
      continue;
    }

    const now = new Date();
    const claim = await prisma.assistantWatch.updateMany({
      where: { id: watch.id, tenantId, active: true, lastCheckedAt: watch.lastCheckedAt },
      data: { lastCheckedAt: now },
    });
    if (claim.count !== 1) continue;
    checked++;

    let result: Check;
    try {
      result = await check(user, tenantId, watch, now);
    } catch (error) {
      await logError("assistant-watch", "watch check failed", error instanceof Error ? error.name : "unknown");
      continue;
    }

    // Its one record is gone or no longer theirs: switch off, and say so in
    // their thread so it doesn't just go quiet.
    if (result === "gone") {
      await prisma
        .$transaction(async (tx) => {
          const off = await tx.assistantWatch.updateMany({ where: { id: watch.id, tenantId, active: true, lastCheckedAt: now }, data: { active: false } });
          if (off.count !== 1) return;
          await tx.assistantTurn.create({ data: { tenantId, userId: user.id, question: watch.label, answer: WATCH_GONE_NOTE, source: "watch" } });
        })
        .catch((error: unknown) => logError("assistant-watch", "watch switch-off failed", error instanceof Error ? error.name : "unknown"));
      continue;
    }

    const { toNotify, fired: nextFired } = nextFiredState(watch.fired, result.map((h) => h.id), now);
    if (!toNotify.length) {
      // Nothing new; records that stopped matching drop out so they can fire again later.
      if (firedChanged(watch.fired, nextFired)) {
        await prisma.assistantWatch.updateMany({ where: { id: watch.id, tenantId, lastCheckedAt: now }, data: { fired: nextFired } });
      }
      continue;
    }

    // One note per watch per tick, naming the new records. The fired map, the
    // one-shot switch-off and the note go in together — or not at all, so the
    // person is never told twice or told nothing.
    const news = result.filter((h) => toNotify.includes(h.id));
    const oneShot = ONE_SHOT_KINDS.includes(watch.kind as WatchKind);
    const delivered = await prisma
      .$transaction(async (tx) => {
        const mark = await tx.assistantWatch.updateMany({
          where: { id: watch.id, tenantId, active: true, lastCheckedAt: now },
          data: { fired: nextFired, lastFiredAt: now, ...(oneShot ? { active: false } : {}) },
        });
        if (mark.count !== 1) return false;
        await tx.assistantTurn.create({
          data: { tenantId, userId: user.id, question: watch.label, answer: watchNotification(watch, news), source: "watch" },
        });
        return true;
      })
      .catch(async (error: unknown) => {
        await logError("assistant-watch", "watch note write failed", error instanceof Error ? error.name : "unknown");
        return false;
      });
    if (!delivered) continue;
    fired++;

    assistantName ??= parseProfile(await getSetting(ASSISTANT_PROFILE_KEY).catch(() => null)).name;
    await sendPushToAll(
      { title: assistantName, body: `${assistantName}: something you're watching happened.`, url: "/assistant" },
      "assistant",
      { tenantId, userId: user.id },
    ).catch((error: unknown) => logError("assistant-watch", "push failed", error instanceof Error ? error.name : "unknown"));
  }
  return { checked, fired };
}

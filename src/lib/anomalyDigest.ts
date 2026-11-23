import "server-only";
import { Prisma } from "@prisma/client";
import { prisma, basePrisma } from "./db";
import { automationOn } from "./automationSwitch";
import { getRegionalSettings } from "./settings";
import { getEnabledModuleIds } from "./modules/enabled";
import { sendEmail } from "./email";
import { tenantOrigin } from "./tenantOrigin";
import { brandForTenant, DEFAULT_BRAND } from "./tenantBrand";
import { digestWeekDue } from "./supplierDigestRules";
import {
  ANOMALY_DIGEST_LAST_WEEK,
  ANOMALY_DIGEST_SWITCH,
  CLAIM_BASELINE_DAYS,
  CLAIM_RECENT_DAYS,
  DISCOUNT_BASELINE_DAYS,
  DISCOUNT_RECENT_DAYS,
  REPLY_BASELINE_DAYS,
  REPLY_RECENT_DAYS,
  anomalyDigestEmail,
  claimSpikes,
  findingCount,
  firstReplier,
  quoteDiscountPct,
  replySlips,
  unusualDiscounts,
  windowStart,
  type AnomalyFindings,
  type DiscountQuote,
} from "./anomalyRules";

/**
 * The weekly "unusual activity" email, run (rules: lib/anomalyRules.ts).
 *
 * Three plain reads of ONE workspace's own records — every query names the
 * tenant — and no AI call. Each read is capped, newest first, so a very busy
 * workspace keeps its recent window whole and loses only the oldest baseline.
 */
const READ_CAP = 5000;

/** What stands out in this workspace right now. Reads only; sends nothing. */
export async function findAnomalies(tenantId: string, now: Date): Promise<AnomalyFindings> {
  const modules = await getEnabledModuleIds().catch(() => null);
  const on = (id: "warranty" | "support") => modules === null || modules.has(id);

  const claims = on("warranty")
    ? await prisma.warrantyClaim.findMany({
        where: { tenantId, claimedAt: { gte: windowStart(now, CLAIM_RECENT_DAYS + CLAIM_BASELINE_DAYS) } },
        select: { claimedAt: true, vehicle: { select: { model: true } } },
        orderBy: { claimedAt: "desc" },
        take: READ_CAP,
      })
    : [];

  const tickets = on("support")
    ? await prisma.customerCase.findMany({
        where: {
          tenantId,
          createdAt: { gte: windowStart(now, REPLY_RECENT_DAYS + REPLY_BASELINE_DAYS) },
          firstResponseAt: { not: null },
        },
        select: {
          createdAt: true,
          firstResponseAt: true,
          // The opening message (staff-opened tickets) and the first reply are the first two; a third for safety.
          messages: { where: { type: "staff", userId: { not: null } }, orderBy: { createdAt: "asc" }, take: 3, select: { userId: true, createdAt: true } },
        },
        orderBy: { createdAt: "desc" },
        take: READ_CAP,
      })
    : [];
  // Credited to whoever wrote the first reply, not the current assignee (a transfer would blame the wrong person).
  const replied = tickets.flatMap((ticket) => {
    const personId = ticket.firstResponseAt ? firstReplier(ticket.messages, ticket.firstResponseAt) : null;
    return personId && ticket.firstResponseAt ? [{ personId, createdAt: ticket.createdAt, firstResponseAt: ticket.firstResponseAt }] : [];
  });
  const personIds = [...new Set(replied.map((ticket) => ticket.personId))];
  const people = personIds.length ? await prisma.user.findMany({ where: { id: { in: personIds } }, select: { id: true, name: true } }) : [];

  // Dated by when each quote was FIRST SENT (Quote.sentAt, set by a trigger), not when it was drafted. Whatever its
  // status now: a quote sent and later declined or cancelled was still offered. A draft never sent has no sentAt. The
  // current revision only: a superseded quote would count one offer twice (its revision has its own sentAt).
  const quotes = await prisma.quote.findMany({
    where: {
      tenantId,
      deletedAt: null,
      supersededAt: null,
      sentAt: { gte: windowStart(now, DISCOUNT_RECENT_DAYS + DISCOUNT_BASELINE_DAYS) },
    },
    select: {
      id: true,
      number: true,
      sentAt: true,
      createdBy: { select: { name: true } },
      items: { select: { qty: true, unitPriceCents: true, discountPct: true, kind: true, optional: true, selected: true } },
    },
    orderBy: { sentAt: "desc" },
    take: READ_CAP,
  });
  const discounted: DiscountQuote[] = quotes.flatMap((quote) => {
    const pct = quote.sentAt ? quoteDiscountPct(quote.items) : null;
    return pct === null || !quote.sentAt ? [] : [{ id: quote.id, number: quote.number, by: quote.createdBy?.name ?? null, sentAt: quote.sentAt, pct }];
  });

  return {
    claims: claimSpikes(claims.map((claim) => ({ model: claim.vehicle.model, claimedAt: claim.claimedAt })), now),
    replies: replySlips(replied, new Map(people.map((person) => [person.id, person.name])), now),
    discounts: unusualDiscounts(discounted, now),
  };
}

/**
 * The automations cron's "anomaly-digest" phase, once per workspace per tick: on Monday from 07:00 (workspace
 * time) — or the first tick after it this week — email the owner what stood out. The week is CLAIMED before
 * sending (conditionally, on the value read), so two ticks can't both send; a failed send hands it back.
 * A week with nothing unusual keeps its claim and sends nothing.
 */
export async function runAnomalyDigest(tenantId: string | null): Promise<{ sent: number; findings: number } | { skipped: string }> {
  if (!tenantId) return { skipped: "no-workspace" };
  if (!(await automationOn(ANOMALY_DIGEST_SWITCH, tenantId))) return { skipped: "switched-off" };
  const { timeZone } = await getRegionalSettings();
  const stored = await basePrisma.appSetting.findUnique({ where: { tenantId_key: { tenantId, key: ANOMALY_DIGEST_LAST_WEEK } }, select: { value: true } });
  const now = new Date();
  const week = digestWeekDue(now, timeZone, stored?.value ?? null);
  if (!week) return { skipped: "not-due" };

  // Claim this week before anything goes out.
  if (stored) {
    const claimed = await basePrisma.appSetting.updateMany({ where: { tenantId, key: ANOMALY_DIGEST_LAST_WEEK, value: stored.value }, data: { value: week } });
    if (claimed.count !== 1) return { skipped: "claimed" };
  } else {
    try {
      await basePrisma.appSetting.create({ data: { tenantId, key: ANOMALY_DIGEST_LAST_WEEK, value: week } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { skipped: "claimed" };
      throw error;
    }
  }
  const handBack = () =>
    stored
      ? basePrisma.appSetting.updateMany({ where: { tenantId, key: ANOMALY_DIGEST_LAST_WEEK, value: week }, data: { value: stored.value } })
      : basePrisma.appSetting.deleteMany({ where: { tenantId, key: ANOMALY_DIGEST_LAST_WEEK, value: week } });

  try {
    const owner = await basePrisma.tenant.findUnique({ where: { id: tenantId }, select: { owner: { select: { email: true } } } });
    if (!owner?.owner?.email) return { skipped: "no-owner-email" };
    const [found, origin, brand] = await Promise.all([
      findAnomalies(tenantId, now),
      tenantOrigin(tenantId),
      brandForTenant(tenantId).catch(() => DEFAULT_BRAND),
    ]);
    const email = anomalyDigestEmail({ brand: brand.displayName, origin: origin || "", ...found });
    if (!email) return { sent: 0, findings: 0 };
    const sent = await sendEmail({ to: owner.owner.email, subject: email.subject, text: email.text });
    if (!sent.ok) throw new Error(sent.error ?? "the mail server refused the unusual-activity email");
    return { sent: 1, findings: findingCount(found) };
  } catch (error) {
    await handBack().catch(() => {});
    throw error;
  }
}

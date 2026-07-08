import { differenceInCalendarMonths } from "date-fns";
import { prisma } from "./db";
import { getSetting } from "./settings";
import { sendEmail } from "./email";
import { logAudit } from "./audit";

const ANNIVERSARY_MARKER = "Purchase anniversary";
const WINBACK_MARKER = "Win-back";

async function recentlyMessaged(contactId: string, marker: string, days: number): Promise<boolean> {
  const hit = await prisma.communication.findFirst({
    where: {
      contactId,
      subject: { contains: marker },
      occurredAt: { gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) },
    },
  });
  return Boolean(hit);
}

async function logJourneyMessage(contactId: string, subject: string, body: string) {
  const firstUser = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (firstUser) {
    await prisma.communication.create({
      data: { type: "email", direction: "outbound", subject, body, contactId, userId: firstUser.id },
    });
  }
}

/** Wish cart owners a happy purchase anniversary (once a year, on the day). */
async function anniversaryJourney(now: Date): Promise<number> {
  if ((await getSetting("LIFECYCLE_ANNIVERSARY_ENABLED")) !== "true") return 0;
  const vehicles = await prisma.vehicle.findMany({
    where: { purchaseDate: { not: null } },
    include: { contact: true },
  });
  let sent = 0;
  for (const v of vehicles) {
    const p = v.purchaseDate!;
    if (p.getMonth() !== now.getMonth() || p.getDate() !== now.getDate()) continue;
    const years = now.getFullYear() - p.getFullYear();
    if (years < 1) continue;
    const c = v.contact;
    if (!c.email) continue;
    if (await recentlyMessaged(c.id, ANNIVERSARY_MARKER, 300)) continue;

    const subject = `Happy ${years}-year anniversary with your ${v.model}! 🎉`;
    const body = `Hi ${c.firstName},\n\nIt's been ${years} year${years === 1 ? "" : "s"} since you got your ${v.model} — thank you for being part of the Denago Cape Town family!\n\nIf it's due some love (a service, new accessories, or a battery health check), we're a call away on 073 789 3438.\n\nWarm regards,\nDenago Cape Town`;
    const res = await sendEmail({ to: c.email, subject, text: body });
    if (!res.ok) continue;
    await logJourneyMessage(c.id, `[${ANNIVERSARY_MARKER}] ${subject}`, body);
    await logAudit({
      action: "lifecycle.anniversary",
      summary: `Anniversary email sent to ${c.firstName} (${years}y — ${v.model})`,
      contactId: c.id,
      userName: "Automation",
    });
    sent += 1;
  }
  return sent;
}

/** Win back cart owners who haven't serviced or been in touch for a long while. */
async function winBackJourney(now: Date): Promise<number> {
  if ((await getSetting("LIFECYCLE_WINBACK_ENABLED")) !== "true") return 0;
  const vehicles = await prisma.vehicle.findMany({
    include: {
      contact: { include: { communications: { select: { occurredAt: true }, orderBy: { occurredAt: "desc" }, take: 1 } } },
      serviceRecords: { select: { serviceDate: true }, orderBy: { serviceDate: "desc" }, take: 1 },
    },
  });
  const done = new Set<string>();
  let sent = 0;
  for (const v of vehicles) {
    const c = v.contact;
    if (done.has(c.id) || !c.email || c.marketingOptOut) continue;

    const lastService = v.serviceRecords[0]?.serviceDate ?? null;
    const baseline = lastService ?? v.purchaseDate;
    if (!baseline) continue;
    if (differenceInCalendarMonths(now, baseline) < 12) continue; // not lapsed

    const lastContact = c.communications[0]?.occurredAt ?? null;
    if (lastContact && differenceInCalendarMonths(now, lastContact) < 3) continue; // recently in touch

    if (await recentlyMessaged(c.id, WINBACK_MARKER, 180)) continue;

    done.add(c.id);
    const subject = `We miss you at Denago Cape Town`;
    const body = `Hi ${c.firstName},\n\nIt's been a while since we saw your ${v.model}! A quick service keeps it running like new and protects its battery.\n\nBook now and we'll take great care of it — call us on 073 789 3438.\n\nWarm regards,\nDenago Cape Town`;
    const res = await sendEmail({ to: c.email, subject, text: body });
    if (!res.ok) continue;
    await logJourneyMessage(c.id, `[${WINBACK_MARKER}] ${subject}`, body);
    await logAudit({
      action: "lifecycle.winback",
      summary: `Win-back email sent to ${c.firstName} (${v.model})`,
      contactId: c.id,
      userName: "Automation",
    });
    sent += 1;
  }
  return sent;
}

/** Pre-built lifecycle journeys. Both are opt-in (Settings → Email). */
export async function runLifecycleJourneys(): Promise<number> {
  const now = new Date();
  const a = await anniversaryJourney(now);
  const w = await winBackJourney(now);
  return a + w;
}

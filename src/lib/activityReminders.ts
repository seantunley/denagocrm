import { prisma, basePrisma } from "./db";
import { sendPushToAll } from "./push";
import { contactName } from "./format";

export const mapsLink = (location: string) =>
  location.startsWith("http")
    ? location
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;

/**
 * Hour-before nudges for timed activities (meetings, test drives…). Tapping
 * the push opens Google Maps when a location is set. Runs from the 15-min
 * cron; each activity reminds once.
 */
export async function runActivityReminders(): Promise<number> {
  const now = new Date();
  const inAnHour = new Date(now.getTime() + 60 * 60 * 1000);
  const upcoming = await prisma.activity.findMany({
    where: {
      status: "planned",
      reminderSentAt: null,
      dueDate: { gt: now, lte: inAnHour },
    },
    include: { lead: true, contact: true, assignedTo: true },
    take: 10,
  });
  let sent = 0;
  for (const a of upcoming) {
    // date-only activities (midnight) don't get hour-before nudges
    if (a.dueDate.getUTCHours() === 0 && a.dueDate.getUTCMinutes() === 0) continue;
    const mins = Math.max(1, Math.round((a.dueDate.getTime() - now.getTime()) / 60000));
    const who = a.contact ? contactName(a.contact) : a.lead?.name ?? "";
    await sendPushToAll(
      {
        title: `⏰ In ${mins} min: ${a.summary}`.slice(0, 100),
        body: [who, a.location ? `📍 ${a.location} — tap for directions` : null, a.assignedTo.name]
          .filter(Boolean)
          .join(" · "),
        url: a.location ? mapsLink(a.location) : "/activities",
      },
      "activity_reminder"
    ).catch(() => {});
    await basePrisma.activity.update({
      where: { id: a.id },
      data: { reminderSentAt: new Date() },
    });
    sent++;
  }
  return sent;
}

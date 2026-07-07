import { subDays } from "date-fns";
import { prisma, basePrisma } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { quoteExpired } from "@/lib/quoteExpiry";
import { formatDate } from "@/lib/format";

const BASE = "https://crm.denagocpt.co.za";
const REMIND_AFTER_DAYS = 3;

/**
 * One polite nudge per quote: signing link sent 3+ days ago, not signed,
 * not declined, not expired, reminder not yet sent. Runs from the cron.
 */
export async function runQuoteSigningReminders(): Promise<number> {
  const quotes = await prisma.quote.findMany({
    where: {
      signToken: { not: null },
      signedAt: null,
      declinedAt: null,
      reminderSentAt: null,
      signLinkCreatedAt: { lt: subDays(new Date(), REMIND_AFTER_DAYS) },
    },
    include: { contact: true, lead: true },
    take: 25,
  });
  if (quotes.length === 0) return 0;

  const firstUser = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  let sent = 0;
  for (const q of quotes) {
    if (quoteExpired(q.validUntil)) continue;
    const to = q.contact?.email ?? q.lead?.email;
    if (!to) continue;
    const firstName =
      q.contact?.firstName ?? q.lead?.name.split(/\s+/)[0] ?? "there";
    const link = `${BASE}/sign/quote/${q.signToken}`;
    const res = await sendEmail({
      to,
      subject: `Friendly reminder: your Denago Cape Town quote Q-${q.number}`,
      text: `Hi ${firstName},\n\nJust a friendly nudge — your quotation Q-${q.number} is still waiting for you. You can review and accept it online here:\n\n${link}\n\n${
        q.validUntil ? `It's valid until ${formatDate(q.validUntil)}.\n\n` : ""
      }Any questions at all, reply to this email or call us on 073 789 3438.\n\nWarm regards,\nDenago Cape Town`,
    });
    if (!res.ok) continue;
    await basePrisma.quote.update({
      where: { id: q.id },
      data: { reminderSentAt: new Date() },
    });
    if (firstUser) {
      await prisma.communication.create({
        data: {
          type: "email",
          direction: "outbound",
          subject: `Quote Q-${q.number} — automatic signing reminder`,
          body: `Automatic reminder sent: quote Q-${q.number} unsigned ${REMIND_AFTER_DAYS} days after the signing link was sent.`,
          contactId: q.contactId,
          leadId: q.leadId,
          userId: firstUser.id,
        },
      });
    }
    sent++;
  }
  return sent;
}

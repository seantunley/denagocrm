import { prisma } from "./db";
import { customerRecordTenantId } from "./customerRecordTenant";
import { resolveTenantActor } from "./tenantActor";
import { resolveTenantCredential } from "./settings";
import { currentTenantScope } from "./tenantScope";
import { sendEmail } from "./email";
import { logAudit } from "./audit";
import { getCompanyProfile } from "./companyProfile";
import { canContactPerson, describeBlockedReason } from "./communicationPolicy";

const REVIEW_MARKER = "Google review request";

/**
 * Asks a happy customer for a Google review — sent ONLY on new-cart delivery
 * or job-card completion (the two moments Sean chose). One request per
 * customer per 90 days, and only when a Place ID + SMTP are configured.
 */
export async function sendReviewRequest(
  contactId: string,
  occasion: "delivery" | "service",
  refText: string
): Promise<boolean> {
  const placeId = await resolveTenantCredential(currentTenantScope()?.tenantId ?? null, "GOOGLE_PLACE_ID");
  if (!placeId) return false;
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact?.email) return false;

  // A review ask is solicitation: marketing opt-out, withdrawn marketing consent
  // and the portal "Marketing emails" switch all refuse it, as does Trash.
  const verdict = await canContactPerson({
    contactId,
    tenantId: contact.tenantId,
    purpose: "review",
    requestedChannel: "email",
  });
  if (!verdict.allowed) {
    await logAudit({
      action: "communication.suppressed",
      summary: `Google review request (${occasion}) not sent — ${describeBlockedReason(verdict.reason)}`,
      contactId,
      userName: "System",
    });
    return false;
  }

  // Don't nag: one review ask per customer per 90 days
  const recent = await prisma.communication.findFirst({
    where: {
      contactId,
      subject: { contains: REVIEW_MARKER },
      occurredAt: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
    },
  });
  if (recent) return false;

  const reviewLink = `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`;
  const firstName = contact.firstName;
  // The workspace's own Company Profile, not Denago's name and landline.
  const company = await getCompanyProfile(await customerRecordTenantId({ contactId }));
  const callUs = company.phone ? ` on ${company.phone}` : "";
  const text =
    occasion === "delivery"
      ? `Hi ${firstName},\n\nCongratulations on your new ${refText} — welcome to the ${company.name} family! 🎉\n\nIf you're enjoying it, it would mean the world to us if you shared your experience in a quick Google review (it takes under a minute):\n\n${reviewLink}\n\nAnything you need, we're a call away${callUs}.\n\nWarm regards,\n${company.name}`
      : `Hi ${firstName},\n\nThanks for trusting us with ${refText} — we hope everything is running perfectly.\n\nIf you were happy with the service, a quick Google review would mean a lot to our small team (it takes under a minute):\n\n${reviewLink}\n\nAnything not 100%? Rather call us first${callUs} and we'll make it right.\n\nWarm regards,\n${company.name}`;

  const res = await sendEmail({
    to: contact.email,
    subject:
      occasion === "delivery"
        ? `Enjoying your new ${refText}? We'd love a quick review ⭐`
        : "How was your service? A quick review would mean a lot ⭐",
    text,
  });
  if (!res.ok) return false;

  const firstUser = await resolveTenantActor();
  if (firstUser) {
    await prisma.communication.create({
      data: {
        type: "email",
        direction: "outbound",
        subject: `${REVIEW_MARKER} (${occasion})`,
        body: `Automatic Google review request sent after ${
          occasion === "delivery" ? `delivery of ${refText}` : refText
        }.`,
        contactId,
        userId: firstUser.id,
        tenantId: await customerRecordTenantId({ contactId }),
      },
    });
  }
  await logAudit({
    action: "review.requested",
    summary: `Google review request emailed (${occasion} — ${refText})`,
    contactId,
    userName: "System",
  });
  return true;
}

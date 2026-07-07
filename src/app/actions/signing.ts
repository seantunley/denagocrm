"use server";

import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { sendEmail } from "@/lib/email";
import { saveFile } from "@/lib/storage";
import { contactName } from "@/lib/format";

/** Denago countersigns a quote (required before it can go to the customer). */
export async function signAsDealer(
  quoteId: string,
  signatureDataUrl: string | null,
  saveForReuse: boolean
): Promise<{ ok?: boolean; error?: string }> {
  const user = await requireUser();
  let ref: string | null;
  if (signatureDataUrl) {
    if (!signatureDataUrl.startsWith("data:image/png;base64,") || signatureDataUrl.length > 400_000) {
      return { error: "Invalid signature image." };
    }
    const buf = Buffer.from(signatureDataUrl.split(",")[1], "base64");
    ref = await saveFile(buf, `dealer-signature-${user.id}.png`, "image/png");
    if (saveForReuse) {
      await prisma.user.update({ where: { id: user.id }, data: { drawnSignatureRef: ref } });
    }
  } else {
    ref = user.drawnSignatureRef;
    if (!ref) return { error: "No saved signature yet — draw one first." };
  }
  const quote = await prisma.quote.update({
    where: { id: quoteId },
    data: { dealerSignedAt: new Date(), dealerSignedByName: user.name, dealerSignatureRef: ref },
  });
  await logAudit({
    action: "quote.dealer_signed",
    summary: `Quote Q-${quote.number} countersigned for Denago by ${user.name}`,
    leadId: quote.leadId,
    contactId: quote.contactId,
    user,
  });
  revalidatePath(`/quotes/${quoteId}`);
  return { ok: true };
}

const BASE = "https://crm.denagocpt.co.za";

/** Creates (or returns) the secure signing link for a quote/job card. */
export async function enableSigning(kind: "quote" | "jobcard", id: string) {
  const user = await requireUser();
  const token = crypto.randomBytes(28).toString("hex");
  if (kind === "quote") {
    const quote = await prisma.quote.findUniqueOrThrow({ where: { id } });
    if (!quote.dealerSignedAt) return; // must be countersigned by Denago first
    if (!quote.signToken) {
      await prisma.quote.update({
        where: { id },
        data: { signToken: token, signLinkCreatedAt: new Date() },
      });
      await logAudit({
        action: "quote.sign_link",
        summary: `Signing link created for quote Q-${quote.number}`,
        leadId: quote.leadId,
        contactId: quote.contactId,
        user,
      });
    }
    revalidatePath(`/quotes/${id}`);
  } else {
    const jobCard = await prisma.jobCard.findUniqueOrThrow({ where: { id } });
    if (!jobCard.signToken) {
      await prisma.jobCard.update({ where: { id }, data: { signToken: token } });
      await logAudit({
        action: "jobcard.sign_link",
        summary: `Signing link created for job card #${jobCard.number}`,
        contactId: jobCard.contactId,
        user,
      });
    }
    revalidatePath(`/jobcards/${id}`);
  }
}

/** Kills an active signing link (wrong recipient, changed quote, etc.). */
export async function revokeSigning(kind: "quote" | "jobcard", id: string) {
  const user = await requireUser();
  if (kind === "quote") {
    const quote = await prisma.quote.findUniqueOrThrow({ where: { id } });
    if (!quote.signToken || quote.signedAt) return; // nothing to revoke / already signed
    await prisma.quote.update({
      where: { id },
      data: { signToken: null, signLinkCreatedAt: null, viewedAt: null, reminderSentAt: null },
    });
    await logAudit({
      action: "quote.sign_link_revoked",
      summary: `Signing link for quote Q-${quote.number} revoked — the old link no longer works`,
      leadId: quote.leadId,
      contactId: quote.contactId,
      user,
    });
    revalidatePath(`/quotes/${id}`);
  } else {
    const jobCard = await prisma.jobCard.findUniqueOrThrow({ where: { id } });
    if (!jobCard.signToken || jobCard.signedAt) return;
    await prisma.jobCard.update({
      where: { id },
      data: { signToken: null, viewedAt: null },
    });
    await logAudit({
      action: "jobcard.sign_link_revoked",
      summary: `Signing link for job card #${jobCard.number} revoked`,
      contactId: jobCard.contactId,
      user,
    });
    revalidatePath(`/jobcards/${id}`);
  }
}

/** Emails the signing link to the customer. */
export async function emailSigningLink(kind: "quote" | "jobcard", id: string) {
  const user = await requireUser();
  if (kind === "quote") {
    const quote = await prisma.quote.findUniqueOrThrow({
      where: { id },
      include: { contact: true, lead: true },
    });
    const to = quote.contact?.email ?? quote.lead?.email;
    if (!quote.signToken || !to) return;
    const link = `${BASE}/sign/quote/${quote.signToken}`;
    const firstName =
      quote.contact?.firstName ?? quote.lead?.name.split(/\s+/)[0] ?? "there";
    await sendEmail({
      to,
      subject: `Your Denago Cape Town quote Q-${quote.number} — review & sign online`,
      text: `Hi ${firstName},\n\nYour quotation Q-${quote.number} is ready. You can review and accept it online here:\n\n${link}\n\nAny questions, just reply or call us on 073 789 3438.\n\nWarm regards,\n${user.name}\nDenago Cape Town`,
    });
    await prisma.communication.create({
      data: {
        type: "email",
        direction: "outbound",
        subject: `Quote Q-${quote.number} — signing link`,
        body: `Sent online signing link for quote Q-${quote.number}: ${link}`,
        contactId: quote.contactId,
        leadId: quote.leadId,
        userId: user.id,
      },
    });
    if (quote.status === "draft") {
      await prisma.quote.update({ where: { id }, data: { status: "sent" } });
    }
    revalidatePath(`/quotes/${id}`);
  } else {
    const jobCard = await prisma.jobCard.findUniqueOrThrow({
      where: { id },
      include: { contact: true },
    });
    if (!jobCard.signToken || !jobCard.contact.email) return;
    const link = `${BASE}/sign/jobcard/${jobCard.signToken}`;
    await sendEmail({
      to: jobCard.contact.email,
      subject: `Denago Cape Town job card #${jobCard.number} — sign online`,
      text: `Hi ${jobCard.contact.firstName},\n\nPlease review and sign job card #${jobCard.number} here:\n\n${link}\n\nWarm regards,\n${user.name}\nDenago Cape Town`,
    });
    await prisma.communication.create({
      data: {
        type: "email",
        direction: "outbound",
        subject: `Job card #${jobCard.number} — signing link`,
        body: `Sent online signing link for job card #${jobCard.number}: ${link}`,
        contactId: jobCard.contactId,
        userId: user.id,
      },
    });
    revalidatePath(`/jobcards/${id}`);
  }
  void contactName;
}

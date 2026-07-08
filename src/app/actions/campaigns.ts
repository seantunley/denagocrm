"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireCrm } from "@/lib/auth";
import { sendEmail, isSmtpConfigured, renderTemplate } from "@/lib/email";
import { sendSms, isSmsConfigured } from "@/lib/sms";
import { contactName } from "@/lib/format";
import { logAudit } from "@/lib/audit";

export type CampaignState = { ok?: string; error?: string };

const MAX_RECIPIENTS = 250;
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();

/* eslint-disable @typescript-eslint/no-explicit-any */
async function resolveRecipients(audience: string, channel: string) {
  const where: any = { deletedAt: null, marketingOptOut: false };
  if (audience === "vehicle_owners") where.vehicles = { some: { deletedAt: null } };
  else if (audience.startsWith("tag:")) where.tags = { some: { id: audience.slice(4) } };
  if (channel === "email") where.email = { not: null };
  const contacts = await prisma.contact.findMany({
    where,
    take: MAX_RECIPIENTS,
    orderBy: { createdAt: "desc" },
  });
  return channel === "sms"
    ? contacts.filter((c) => c.whatsapp || c.phone)
    : contacts.filter((c) => c.email);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function audienceLabel(audience: string, tagName?: string) {
  if (audience === "vehicle_owners") return "Vehicle owners";
  if (audience.startsWith("tag:")) return `Tag: ${tagName ?? "?"}`;
  return "All customers";
}

/** Send a single test to a typed address/number without recording a campaign. */
export async function sendCampaignTest(
  _prev: CampaignState | undefined,
  formData: FormData
): Promise<CampaignState> {
  await requireCrm();
  const channel = str(formData.get("channel")) || "email";
  const to = str(formData.get("testTo"));
  const subject = str(formData.get("subject")) || "Test";
  const body = str(formData.get("body"));
  if (!to) return { error: "Enter a test address / number." };
  if (!body) return { error: "Write a message first." };
  const vars = { first_name: "there", name: "there" };
  const text = renderTemplate(body, vars);
  const res =
    channel === "email"
      ? await sendEmail({ to, subject: renderTemplate(subject, vars), text })
      : await sendSms(to, text);
  return res.ok ? { ok: `Test ${channel} sent to ${to}.` } : { error: res.error ?? "Send failed." };
}

export async function sendCampaign(
  _prev: CampaignState | undefined,
  formData: FormData
): Promise<CampaignState> {
  const user = await requireCrm();
  const name = str(formData.get("name"));
  const channel = str(formData.get("channel")) || "email";
  const audience = str(formData.get("audience")) || "all";
  const subject = str(formData.get("subject"));
  const body = str(formData.get("body"));
  if (!name) return { error: "Give the campaign a name." };
  if (!body) return { error: "Write a message." };
  if (channel === "email" && !subject) return { error: "Email needs a subject." };
  if (channel === "email" && !(await isSmtpConfigured()))
    return { error: "Email isn't configured (Settings → Email)." };
  if (channel === "sms" && !(await isSmsConfigured()))
    return { error: "SMS isn't configured (Settings → Integrations)." };

  const recipients = await resolveRecipients(audience, channel);
  if (recipients.length === 0) return { error: "No opted-in recipients match that audience." };

  let sent = 0;
  let failed = 0;
  for (const c of recipients) {
    const vars = { first_name: c.firstName, name: contactName(c) };
    const text = renderTemplate(body, vars);
    const res =
      channel === "email"
        ? await sendEmail({ to: c.email!, subject: renderTemplate(subject, vars), text })
        : await sendSms((c.whatsapp ?? c.phone)!, text);
    if (res.ok) {
      sent++;
      await prisma.communication
        .create({
          data: {
            type: channel,
            direction: "outbound",
            subject: channel === "email" ? subject : null,
            body: `[Campaign: ${name}]\n\n${text}`,
            contactId: c.id,
            userId: user.id,
          },
        })
        .catch(() => {});
    } else {
      failed++;
    }
  }

  let tagName: string | undefined;
  if (audience.startsWith("tag:")) {
    tagName = (await prisma.tag.findUnique({ where: { id: audience.slice(4) } }))?.name;
  }
  await prisma.campaign.create({
    data: {
      name,
      channel,
      subject: channel === "email" ? subject : null,
      body,
      audience: audienceLabel(audience, tagName),
      recipientCount: recipients.length,
      sentCount: sent,
      failedCount: failed,
      status: "sent",
      sentAt: new Date(),
      createdById: user.id,
    },
  });
  await logAudit({
    action: "campaign.sent",
    summary: `Campaign "${name}" (${channel}) sent to ${sent}/${recipients.length}${
      failed ? `, ${failed} failed` : ""
    }`,
    user,
  });
  revalidatePath("/campaigns");
  return { ok: `Sent ${sent} of ${recipients.length}${failed ? `, ${failed} failed` : ""}.` };
}

import crypto from "crypto";
import { prisma } from "./db";
import { sendEmail, renderTemplate } from "./email";
import { sendSms } from "./sms";
import { htmlToText } from "./signature";
import { computeDue } from "./serviceDue";
import { contactName } from "./format";
import {
  assertCampaignTransition,
  campaignFinalStatus,
  isCampaignStatus,
} from "./campaignLifecycle";

export type SegmentCriteria = {
  source?: string;
  tagId?: string;
  hasVehicle?: boolean;
  serviceDue?: boolean;
  province?: string;
  wonOnly?: boolean;
};

/** Absolute base URL for tracking/unsubscribe links inside emails. */
export function appBaseUrl() {
  return (process.env.NEXT_PUBLIC_APP_URL || "https://crm.denagocpt.co.za").replace(/\/$/, "");
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function segmentWhere(criteria: SegmentCriteria) {
  const where: any = { deletedAt: null, marketingOptOut: false };
  if (criteria.source) where.source = criteria.source;
  if (criteria.province) where.province = criteria.province;
  if (criteria.tagId) where.tags = { some: { id: criteria.tagId } };
  if (criteria.hasVehicle) where.vehicles = { some: { deletedAt: null } };
  if (criteria.wonOnly) where.leads = { some: { status: "won" } };
  return where;
}

/** Resolve the contacts a segment reaches for a given channel (max 5000). */
export async function resolveContacts(criteria: SegmentCriteria, channel: string) {
  const where = segmentWhere(criteria);
  if (channel === "email") where.email = { not: null };
  const contacts = await prisma.contact.findMany({
    where,
    take: 5000,
    orderBy: { createdAt: "desc" },
    include: criteria.serviceDue
      ? { vehicles: { where: { deletedAt: null }, include: { serviceRecords: true, mileageLogs: true } } }
      : undefined,
  });
  let list = contacts as any[];
  if (criteria.serviceDue) {
    list = list.filter((c) =>
      (c.vehicles ?? []).some((v: any) => {
        const s = computeDue(v).status;
        return s === "due_soon" || s === "overdue";
      })
    );
  }
  if (channel === "sms") return list.filter((c) => c.whatsapp || c.phone);
  if (channel === "email") return list.filter((c) => c.email);
  return list; // "any" — matching opted-in contacts regardless of channel
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function countContacts(criteria: SegmentCriteria, channel: string) {
  return (await resolveContacts(criteria, channel)).length;
}

function emailShell(inner: string, unsubUrl: string) {
  const base = appBaseUrl();
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f1f5f9;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
<tr><td style="background:#0f172a;padding:16px 24px;">
<img src="${base}/branding/denago-cape-town-logo.png" alt="Denago Cape Town" height="26" style="height:26px;">
</td></tr>
<tr><td style="padding:24px;font-size:15px;line-height:1.6;">${inner}</td></tr>
<tr><td style="padding:16px 24px;background:#f8fafc;color:#64748b;font-size:12px;line-height:1.5;">
Denago Cape Town &middot; Cape Town, South Africa<br>
You received this because you're a Denago Cape Town customer.
<a href="${unsubUrl}" style="color:#64748b;">Unsubscribe</a>.
</td></tr>
</table></td></tr></table></body></html>`;
}

/** Wrap personalised HTML with the brand shell, rewrite links for click
 *  tracking, and append the open-tracking pixel + unsubscribe footer. */
export function buildTrackedEmail(personalizedHtml: string, token: string) {
  const base = appBaseUrl();
  const rewritten = personalizedHtml.replace(
    /href="(https?:\/\/[^"]+)"/g,
    (_m, url) => `href="${base}/api/track/c/${token}?u=${encodeURIComponent(url)}"`
  );
  const pixel = `<img src="${base}/api/track/o/${token}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;overflow:hidden;">`;
  return emailShell(rewritten + pixel, `${base}/api/unsubscribe/${token}`);
}

export function newToken() {
  return crypto.randomBytes(18).toString("hex");
}

async function finalizeIfDone(campaignId: string) {
  const remaining = await prisma.campaignRecipient.count({
    where: { campaignId, status: { in: ["pending", "queued", "sending"] } },
  });
  if (remaining !== 0) return;

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { status: true, failedCount: true },
  });
  if (!campaign || !isCampaignStatus(campaign.status)) return;

  let current = campaign.status;
  if (current === "queued") {
    assertCampaignTransition(current, "sending");
    await prisma.campaign.update({ where: { id: campaignId }, data: { status: "sending" } });
    current = "sending";
  }
  if (current !== "sending") return;

  const finalStatus = campaignFinalStatus({ failedCount: campaign.failedCount });
  assertCampaignTransition(current, finalStatus);
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { status: finalStatus, sentAt: new Date() },
  });
}

/**
 * Legacy bounded sender retained until the queue-safety PR replaces recipient
 * claiming and delivery policy. It now obeys the governed status vocabulary and
 * will not process paused, cancelled, completed or archived campaigns.
 */
export async function sendCampaignBatch(campaignId: string, limit = 80): Promise<number> {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign || !["queued", "sending"].includes(campaign.status)) return 0;
  const recipients = await prisma.campaignRecipient.findMany({
    where: { campaignId, status: "queued" },
    include: { contact: true },
    take: limit,
  });
  if (recipients.length === 0) {
    await finalizeIfDone(campaignId);
    return 0;
  }
  if (campaign.status === "queued") {
    assertCampaignTransition("queued", "sending");
    await prisma.campaign.update({ where: { id: campaignId }, data: { status: "sending" } });
  }

  let sent = 0;
  let failed = 0;
  for (const r of recipients) {
    const c = r.contact;
    const vars = { first_name: c.firstName, name: contactName(c) };
    let res: { ok: boolean; error?: string };
    if (campaign.channel === "email") {
      const subject = renderTemplate(campaign.subject ?? "", vars);
      const personalized = renderTemplate(campaign.htmlBody ?? campaign.body, vars);
      const html = buildTrackedEmail(personalized, r.token);
      const text = renderTemplate(campaign.body, vars);
      res = await sendEmail({ to: c.email!, subject, text, html });
    } else {
      res = await sendSms((c.whatsapp ?? c.phone)!, renderTemplate(campaign.body, vars));
    }
    if (res.ok) {
      sent++;
      await prisma.campaignRecipient.update({
        where: { id: r.id },
        data: { status: "sent", sentAt: new Date() },
      });
    } else {
      failed++;
      await prisma.campaignRecipient.update({
        where: { id: r.id },
        data: { status: "failed_permanent", error: (res.error ?? "send failed").slice(0, 200) },
      });
    }
  }
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { sentCount: { increment: sent }, failedCount: { increment: failed } },
  });
  await finalizeIfDone(campaignId);
  return recipients.length;
}

/** Drain queued recipients across all in-flight campaigns (cron). */
export async function runCampaignQueue(maxTotal = 150): Promise<number> {
  const active = await prisma.campaign.findMany({
    where: { status: { in: ["queued", "sending"] } },
    orderBy: { createdAt: "asc" },
  });
  let done = 0;
  for (const c of active) {
    if (done >= maxTotal) break;
    done += await sendCampaignBatch(c.id, Math.min(80, maxTotal - done));
  }
  return done;
}

export { htmlToText };

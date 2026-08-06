import crypto from "crypto";
import { prisma } from "./db";
import { sendEmail, renderTemplate } from "./email";
import { sendSms } from "./sms";
import { emailBrand, type EmailBrand } from "./emailBrand";
import { htmlToText } from "./signature";
import { computeDue } from "./serviceDue";
import { contactName } from "./format";
import { currentTenantScope } from "./tenantScope";
import { trackedLinkPattern } from "./trackRedirect";

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
function segmentWhere(tenantId: string, criteria: SegmentCriteria) {
  const where: any = { tenantId, deletedAt: null, marketingOptOut: false };
  if (criteria.source) where.source = criteria.source;
  if (criteria.province) where.province = criteria.province;
  if (criteria.tagId) where.tags = { some: { id: criteria.tagId, tenantId } };
  if (criteria.hasVehicle) where.vehicles = { some: { tenantId, deletedAt: null } };
  if (criteria.wonOnly) where.leads = { some: { tenantId, status: "won", deletedAt: null } };
  return where;
}

/** Resolve one tenant's contacts reached by a segment for a given channel (max 5000). */
export function resolveContacts(
  tenantId: string,
  criteria: SegmentCriteria,
  channel: string,
): Promise<any[]>;
/** Legacy internal callers may rely on an already-established tenant scope. */
export function resolveContacts(criteria: SegmentCriteria, channel: string): Promise<any[]>;
export async function resolveContacts(
  tenantOrCriteria: string | SegmentCriteria,
  criteriaOrChannel: SegmentCriteria | string,
  maybeChannel?: string,
): Promise<any[]> {
  const explicitTenant = typeof tenantOrCriteria === "string" ? tenantOrCriteria : null;
  const tenantId = explicitTenant ?? currentTenantScope()?.tenantId ?? null;
  const criteria = (explicitTenant ? criteriaOrChannel : tenantOrCriteria) as SegmentCriteria;
  const channel = (explicitTenant ? maybeChannel : criteriaOrChannel) as string;
  if (!tenantId) return [];

  const where = segmentWhere(tenantId, criteria);
  if (channel === "email") where.email = { not: null };
  const contacts = await prisma.contact.findMany({
    where,
    take: 5000,
    orderBy: { createdAt: "desc" },
    include: criteria.serviceDue
      ? {
          vehicles: {
            where: { tenantId, deletedAt: null },
            include: { serviceRecords: true, mileageLogs: true },
          },
        }
      : undefined,
  });
  let list = contacts as any[];
  if (criteria.serviceDue) {
    list = list.filter((c) =>
      (c.vehicles ?? []).some((v: any) => {
        const s = computeDue(v).status;
        return s === "due_soon" || s === "overdue";
      }),
    );
  }
  if (channel === "sms") return list.filter((c) => c.whatsapp || c.phone);
  if (channel === "email") return list.filter((c) => c.email);
  return list; // "any" — matching opted-in contacts regardless of channel
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function countContacts(
  tenantId: string,
  criteria: SegmentCriteria,
  channel: string,
) {
  return (await resolveContacts(tenantId, criteria, channel)).length;
}

function emailShell(inner: string, unsubUrl: string, brand?: EmailBrand) {
  const base = appBaseUrl();
  // Absolute URL, always: a mail client has no origin to resolve a relative path
  // against. Falls back to the built-in asset when the tenant has no logo.
  const logo = brand?.logoUrl ?? `${base}/branding/denago-cape-town-logo.png`;
  const name = brand?.branded ? brand.displayName : "Denago Cape Town";
  // The footer line stays EXACTLY as it was for an unbranded send. A tenant
  // supplies a name, not an address, so the location half is dropped rather than
  // invented — a wrong address in a marketing footer is a compliance problem.
  const footer = brand?.branded ? name : "Denago Cape Town &middot; Cape Town, South Africa";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f1f5f9;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
<tr><td style="background:#0f172a;padding:16px 24px;">
<img src="${logo}" alt="${name}" height="26" style="height:26px;">
</td></tr>
<tr><td style="padding:24px;font-size:15px;line-height:1.6;">${inner}</td></tr>
<tr><td style="padding:16px 24px;background:#f8fafc;color:#64748b;font-size:12px;line-height:1.5;">
${footer}<br>
You received this because you're a ${name} customer.
<a href="${unsubUrl}" style="color:#64748b;">Unsubscribe</a>.
</td></tr>
</table></td></tr></table></body></html>`;
}

/** Wrap personalised HTML with the brand shell, rewrite links for click
 *  tracking, and append the open-tracking pixel + unsubscribe footer. */
export function buildTrackedEmail(personalizedHtml: string, token: string, brand?: EmailBrand) {
  const base = appBaseUrl();
  // Same pattern the click route reads the campaign's vouched-for hosts with, so
  // the set of links rewritten here and the set accepted there cannot drift.
  const rewritten = personalizedHtml.replace(
    trackedLinkPattern(),
    (_m, url) => `href="${base}/api/track/c/${token}?u=${encodeURIComponent(url)}"`,
  );
  const pixel = `<img src="${base}/api/track/o/${token}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;overflow:hidden;">`;
  return emailShell(rewritten + pixel, `${base}/api/unsubscribe/${token}`, brand);
}

export function newToken() {
  return crypto.randomBytes(18).toString("hex");
}

async function finalizeIfDone(campaignId: string, tenantId: string) {
  const remaining = await prisma.campaignRecipient.count({
    where: { campaignId, tenantId, status: "queued" },
  });
  if (remaining === 0) {
    await prisma.campaign.update({
      where: { id: campaignId, tenantId },
      data: { status: "sent", sentAt: new Date() },
    });
  }
}

/**
 * Send one tenant-scoped batch of queued recipients for a campaign. Called
 * synchronously on first send and repeatedly from the cron to drain the rest.
 */
export async function sendCampaignBatch(
  campaignId: string,
  tenantId: string,
  limit = 80,
): Promise<number> {
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, tenantId } });
  if (!campaign) return 0;
  const recipients = await prisma.campaignRecipient.findMany({
    where: { campaignId, tenantId, status: "queued", contact: { tenantId } },
    include: { contact: true },
    take: limit,
  });
  if (recipients.length === 0) {
    await finalizeIfDone(campaignId, tenantId);
    return 0;
  }
  if (campaign.status !== "sending") {
    await prisma.campaign.update({
      where: { id: campaignId, tenantId },
      data: { status: "sending" },
    });
  }

  // Resolved ONCE per batch, not per recipient: brandForTenant is cache()d, but a
  // batch is up to 80 sends and the intent should be visible at the loop rather
  // than relying on the cache to make it cheap.
  const brand = await emailBrand(tenantId);

  let sent = 0;
  let failed = 0;
  for (const r of recipients) {
    const c = r.contact;
    const vars = { first_name: c.firstName, name: contactName(c) };
    let res: { ok: boolean; error?: string };
    if (campaign.channel === "email") {
      const subject = renderTemplate(campaign.subject ?? "", vars);
      const personalized = renderTemplate(campaign.htmlBody ?? campaign.body, vars);
      const html = buildTrackedEmail(personalized, r.token, brand);
      const text = renderTemplate(campaign.body, vars);
      res = await sendEmail({ to: c.email!, subject, text, html });
    } else {
      res = await sendSms((c.whatsapp ?? c.phone)!, renderTemplate(campaign.body, vars));
    }
    if (res.ok) {
      sent++;
      await prisma.campaignRecipient.update({
        where: { id: r.id, tenantId },
        data: { status: "sent", sentAt: new Date() },
      });
    } else {
      failed++;
      await prisma.campaignRecipient.update({
        where: { id: r.id, tenantId },
        data: { status: "failed", error: (res.error ?? "send failed").slice(0, 200) },
      });
    }
  }
  await prisma.campaign.update({
    where: { id: campaignId, tenantId },
    data: { sentCount: { increment: sent }, failedCount: { increment: failed } },
  });
  await finalizeIfDone(campaignId, tenantId);
  return recipients.length;
}

/** Drain queued recipients across tenant-stamped in-flight campaigns. */
export async function runCampaignQueue(maxTotal = 150): Promise<number> {
  const active = await prisma.campaign.findMany({
    where: { tenantId: { not: null }, status: { in: ["queued", "sending"] } },
    orderBy: { createdAt: "asc" },
  });
  let done = 0;
  for (const c of active) {
    if (done >= maxTotal) break;
    if (!c.tenantId) continue;
    done += await sendCampaignBatch(c.id, c.tenantId, Math.min(80, maxTotal - done));
  }
  return done;
}

export { htmlToText };

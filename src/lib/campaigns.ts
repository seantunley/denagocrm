import crypto from "crypto";
import { prisma } from "./db";
import { sendEmail, renderTemplate } from "./email";
import { sendSms } from "./sms";
import { emailBrand, type EmailBrand } from "./emailBrand";
import { PLATFORM_NAME } from "./platformIdentity";
import { htmlToText } from "./signature";
import { computeDue } from "./serviceDue";
import { contactName } from "./format";
import { currentTenantScope } from "./tenantScope";
import { trackedLinkPattern } from "./trackRedirect";
import { escapeHtml } from "./escapeHtml";
import { unsubscribeUrlFor, unsubscribeHeadersFor } from "./unsubscribeLinks";
import { inlineEmailStyles } from "./emailInlineStyles";

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
  // Same origin the links use, so the built-in logo fallback does not arrive
  // from a different host than everything around it.
  const base = emailBase(brand);
  // Absolute URL, always: a mail client has no origin to resolve a relative path
  // against. Falls back to the built-in asset when the tenant has no logo.
  const logo = brand?.logoUrl ?? `${base}/branding/denago-cape-town-logo.png`;
  // Unbranded no longer means "Denago". A campaign that could not resolve its
  // tenant used to go out under one customer's trading name and street address —
  // to another customer's mailing list, with an unsubscribe link, which is a
  // compliance problem as much as a branding one. It now names the platform and
  // claims no address, because it does not know one.
  const name = brand?.branded ? brand.displayName : PLATFORM_NAME;
  // Escaped once, here, for every position it is used in below: an alt
  // attribute, the footer, and the "you received this because" sentence. The
  // tenant display name is operator-controlled but it still reaches this
  // tenant's customers, and nothing else in this template is unescaped.
  const safeName = escapeHtml(name);
  const footer = safeName;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f1f5f9;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
<tr><td style="background:#0f172a;padding:16px 24px;">
<img src="${escapeHtml(logo)}" alt="${safeName}" height="26" style="height:26px;">
</td></tr>
<tr><td style="padding:24px;font-size:15px;line-height:1.6;">${inner}</td></tr>
<tr><td style="padding:16px 24px;background:#f8fafc;color:#64748b;font-size:12px;line-height:1.5;">
${footer}<br>
You received this because you're a ${safeName} customer.
<a href="${escapeHtml(unsubUrl)}" style="color:#64748b;">Unsubscribe</a>.
</td></tr>
</table></td></tr></table></body></html>`;
}

/**
 * The base every link in ONE email is built from.
 *
 * One resolver, so the click wrapper, the open pixel, the unsubscribe link in
 * the footer and the `List-Unsubscribe` header cannot end up naming different
 * hosts. A header pointing somewhere the footer does not is how a mail client's
 * unsubscribe button quietly stops matching what the message itself offers.
 */
export function emailBase(brand?: EmailBrand) {
  return brand?.origin || appBaseUrl();
}

/** Where this recipient's unsubscribe link points — footer and header alike. */
export function unsubscribeUrl(token: string, brand?: EmailBrand) {
  return unsubscribeUrlFor(emailBase(brand), token);
}

/** RFC 8058 one-click unsubscribe headers for one recipient. */
export function unsubscribeHeaders(token: string, brand?: EmailBrand): Record<string, string> {
  return unsubscribeHeadersFor(emailBase(brand), token);
}

/** Wrap personalised HTML with the brand shell, rewrite links for click
 *  tracking, and append the open-tracking pixel + unsubscribe footer. */
export function buildTrackedEmail(personalizedHtml: string, token: string, brand?: EmailBrand) {
  // The tenant's own origin for EVERY link in the mail — the click wrapper, the
  // open pixel and the unsubscribe URL. This is the most-seen surface of the
  // lot: a recipient hovers any link in a marketing email and reads the hostname
  // in their status bar, and it read crm.denagocpt.co.za whoever sent it.
  //
  // The unsubscribe URL especially. It is the one link a recipient is invited to
  // click when they do not trust the sender, and pointing it at a company they
  // have never heard of is the worst possible moment to look like a stranger.
  //
  // Old links keep working: every hostname reaches the same deployment and the
  // platform origin stays valid forever, so a campaign sent last month tracks
  // and unsubscribes exactly as before.
  const base = emailBase(brand);
  // INLINE THE BODY'S STYLES BEFORE ANYTHING ELSE TOUCHES IT.
  //
  // The shell around this is already email-safe — a 600px presentation table with
  // inline styles. The BODY was not: a `<p>` or a `<ul>` carrying no style
  // attribute is at the mercy of each client's default stylesheet, and Outlook's
  // is not the browser's. This is the send-time half of the Dittofeed borrow, and
  // it is deliberately not MJML — see emailInlineStyles.ts for why, and for why
  // tables are left alone.
  //
  // Applied FIRST because it only ever adds `style` attributes to opening tags,
  // while the two steps below rewrite `href` values and append markup. Doing it
  // last would mean styling the tracking pixel.
  const styled = inlineEmailStyles(personalizedHtml);
  // Same pattern the click route reads the campaign's vouched-for hosts with, so
  // the set of links rewritten here and the set accepted there cannot drift.
  const rewritten = styled.replace(
    trackedLinkPattern(),
    (_m, url) => `href="${base}/api/track/c/${token}?u=${encodeURIComponent(url)}"`,
  );
  const pixel = `<img src="${base}/api/track/o/${token}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;overflow:hidden;">`;
  return emailShell(rewritten + pixel, unsubscribeUrl(token, brand), brand);
}

/**
 * The template PREVIEW, rendered by the send pipeline itself.
 *
 * Same shell, same style inlining, same brand resolution as a real campaign
 * send — the two deliberately omitted pieces are per-recipient: the tracking
 * rewrite and the open pixel, which need a recipient token that does not exist
 * yet. A preview that renders anything other than the send path is a preview of
 * nothing, which is what the old raw-body iframe was: it showed editor HTML
 * with no shell, no brand and no inlined styles, so the first honest look at a
 * template was the copy in a customer's inbox.
 */
export function emailPreviewHtml(bodyHtml: string, brand?: EmailBrand): string {
  const base = emailBase(brand);
  return emailShell(inlineEmailStyles(bodyHtml), `${base}/unsubscribe/preview`, brand);
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
      res = await sendEmail({
        to: c.email!,
        subject,
        text,
        html,
        headers: unsubscribeHeaders(r.token, brand),
      });
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

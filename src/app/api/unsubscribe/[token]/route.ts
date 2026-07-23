import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveCampaignRecipientTenant } from "@/lib/tokenTenant";

function page(token: string, message?: string) {
  const content = message
    ? `<p style="color:#94a3b8;line-height:1.6;">${message}</p>`
    : `<p style="color:#94a3b8;line-height:1.6;">Stop marketing emails from Denago Cape Town?</p>
       <form method="post" action="/api/unsubscribe/${encodeURIComponent(token)}">
         <button type="submit" style="border:0;border-radius:8px;padding:11px 18px;background:#f97316;color:white;font-weight:700;cursor:pointer;">Unsubscribe</button>
       </form>
       <p style="color:#64748b;font-size:12px;line-height:1.5;">Service reminders and messages about your own orders are unaffected.</p>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Denago Cape Town</title></head>
<body style="margin:0;background:#0f172a;color:#e2e8f0;font-family:Arial,Helvetica,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;">
<div style="max-width:420px;padding:32px;text-align:center;">
<h1 style="font-size:18px;">Denago Cape Town</h1>${content}
</div></body></html>`;
}

function html(token: string, message?: string) {
  return new NextResponse(page(token, message), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * GET is deliberately read-only. Security scanners and mailbox previews follow
 * links automatically, so changing consent on GET would unsubscribe people who
 * never asked to leave.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const valid = await withTokenTenantScope(
    () => resolveCampaignRecipientTenant(token),
    async () => Boolean(await prisma.campaignRecipient.findUnique({ where: { token } })),
    () => false,
  ).catch(() => false);
  return valid ? html(token) : html(token, "This unsubscribe link is no longer valid.");
}

/** RFC 8058 one-click POST and the confirmation form share this idempotent path. */
export async function POST(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    const done = await withTokenTenantScope(
      () => resolveCampaignRecipientTenant(token),
      async () => {
        const recipient = await prisma.campaignRecipient.findUnique({ where: { token } });
        if (!recipient) return false;

        await prisma.contact.update({
          where: { id: recipient.contactId },
          data: { marketingOptOut: true },
        });
        const first = await prisma.campaignRecipient.updateMany({
          where: { id: recipient.id, unsubscribedAt: null },
          data: { unsubscribedAt: new Date() },
        });
        if (first.count > 0) {
          await prisma.campaign.update({
            where: { id: recipient.campaignId },
            data: { unsubscribeCount: { increment: 1 } },
          });
          await prisma.consentRecord.create({
            data: {
              contactId: recipient.contactId,
              type: "marketing",
              granted: false,
              source: "email_unsubscribe",
              note: "Recipient used the campaign unsubscribe link.",
            },
          });
          await prisma.campaignEvent.create({
            data: {
              campaignId: recipient.campaignId,
              recipientId: recipient.id,
              provider: "crm",
              providerEventId: `unsubscribe-${crypto.randomUUID()}`,
              type: "unsubscribe",
              occurredAt: new Date(),
            },
          });
        }
        return true;
      },
      () => false,
    );
    if (!done) return html(token, "This unsubscribe link is no longer valid.");
    return html(
      token,
      "You've been unsubscribed from Denago Cape Town marketing emails. You'll still receive service reminders and messages about your own orders.",
    );
  } catch {
    return html(token, "Something went wrong — please reply to the email and we'll remove you.");
  }
}

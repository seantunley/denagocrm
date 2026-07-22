import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { establishTenantScopeFromId } from "@/lib/tenantScopeEntry";

function page(message: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Denago Cape Town</title></head>
<body style="margin:0;background:#0f172a;color:#e2e8f0;font-family:Arial,Helvetica,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;">
<div style="max-width:420px;padding:32px;text-align:center;">
<h1 style="font-size:18px;">Denago Cape Town</h1>
<p style="color:#94a3b8;line-height:1.6;">${message}</p>
</div></body></html>`;
}

/** One-click unsubscribe from marketing campaigns. */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let message = "This unsubscribe link is no longer valid.";
  try {
    const r = await prisma.campaignRecipient.findUnique({ where: { token } });
    if (r) {
      // Phase C no-user edge: scope the opt-out write to the recipient's tenant
      // (dormant no-op until enforcement).
      establishTenantScopeFromId(r.tenantId);
      await prisma.contact.update({
        where: { id: r.contactId },
        data: { marketingOptOut: true },
      });
      message = "You've been unsubscribed from Denago Cape Town marketing emails. You'll still receive service reminders and messages about your own orders.";
    }
  } catch {
    message = "Something went wrong — please reply to the email and we'll remove you.";
  }
  return new NextResponse(page(message), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

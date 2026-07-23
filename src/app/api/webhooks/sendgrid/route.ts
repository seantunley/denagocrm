import { NextResponse } from "next/server";
import { getTenantEmailProviderConfig } from "@/lib/emailProviderConfig";
import {
  applySendGridEvent,
  sendGridRecipientId,
  type SendGridEvent,
} from "@/lib/sendGridEvents";
import { verifySendGridSignature } from "@/lib/sendGridSignature";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveCampaignRecipientIdTenant } from "@/lib/tokenTenant";

export const runtime = "nodejs";
export const maxDuration = 30;

function response(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-twilio-email-event-webhook-signature");
  const timestamp = request.headers.get("x-twilio-email-event-webhook-timestamp");
  if (!signature || !timestamp) return response("Missing webhook signature.", 401);

  const signedAt = Number(timestamp) * 1000;
  if (!Number.isFinite(signedAt) || Math.abs(Date.now() - signedAt) > 15 * 60 * 1000) {
    return response("Expired webhook signature.", 401);
  }

  let events: SendGridEvent[];
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 1_000) {
      return response("Invalid event batch.", 400);
    }
    events = parsed as SendGridEvent[];
  } catch {
    return response("Invalid JSON.", 400);
  }

  const recipientIds = [...new Set(events.map(sendGridRecipientId).filter((id): id is string => Boolean(id)))];
  if (recipientIds.length === 0) return response("No CRM recipient identifiers.", 400);

  // Validate the raw request against every tenant key represented in the batch
  // before writing any event. The untrusted recipient id only selects a candidate
  // tenant/key; the signature must authenticate the exact raw body.
  for (const recipientId of recipientIds) {
    const valid = await withTokenTenantScope(
      () => resolveCampaignRecipientIdTenant(recipientId),
      async () => {
        const publicKey = (await getTenantEmailProviderConfig()).webhookPublicKey;
        return publicKey
          ? verifySendGridSignature({ publicKey, signature, timestamp, rawBody })
          : false;
      },
      () => false,
    );
    if (!valid) return response("Invalid webhook signature.", 401);
  }

  let applied = 0;
  for (const event of events) {
    const recipientId = sendGridRecipientId(event);
    if (!recipientId) continue;
    const didApply = await withTokenTenantScope(
      () => resolveCampaignRecipientIdTenant(recipientId),
      () => applySendGridEvent(event),
      () => false,
    );
    if (didApply) applied++;
  }

  return NextResponse.json({ accepted: events.length, applied }, { status: 202 });
}

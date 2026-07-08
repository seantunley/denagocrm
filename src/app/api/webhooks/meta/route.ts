import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { createIntakeLead } from "@/lib/leadIntake";
import { parseLeadFields, metaSource } from "@/lib/metaLead";
import { recordInboundDm, recordDmEcho, type DmPlatform } from "@/lib/messenger";
import { runDmFlow } from "@/lib/flowDm";

/** Meta webhook verification handshake. */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  const verifyToken = await getSetting("META_VERIFY_TOKEN");
  if (mode === "subscribe" && token && token === verifyToken && challenge) {
    return new NextResponse(challenge, { status: 200 });
  }
  return new NextResponse("Verification failed", { status: 403 });
}

async function fetchLeadDetails(leadgenId: string, accessToken: string) {
  const res = await fetch(
    `https://graph.facebook.com/v21.0/${leadgenId}?fields=field_data,created_time,ad_name,form_id,platform&access_token=${encodeURIComponent(
      accessToken
    )}`,
    { cache: "no-store", signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error(`Graph API ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Receives leadgen events from Facebook/Instagram Lead Ads. */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  // Verify Meta's payload signature. Fail CLOSED: if no app secret is
  // configured we cannot authenticate the sender, so we reject rather than
  // trust an anonymous POST (which could forge leads/DMs or drive the bot).
  const appSecret = await getSetting("META_APP_SECRET");
  if (!appSecret) {
    return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  }
  {
    const signature = req.headers.get("x-hub-signature-256") ?? "";
    const expected =
      "sha256=" +
      crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
    const valid =
      signature.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    if (!valid) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const objectType = (body as any).object as string | undefined;

  // Messenger / Instagram DM events arrive as entry[].messaging[]
  if (objectType === "page" || objectType === "instagram") {
    const platform: DmPlatform = objectType === "instagram" ? "instagram" : "messenger";
    for (const entry of (body as any).entry ?? []) {
      for (const ev of entry.messaging ?? []) {
        try {
          const text: string = ev.message?.text ?? "";
          const attachments = ((ev.message?.attachments ?? []) as any[])
            .map((a) => ({ type: String(a.type ?? "file"), url: String(a.payload?.url ?? "") }))
            .filter((a) => a.url);
          if (ev.message?.is_echo) {
            if (text) await recordDmEcho(platform, String(ev.recipient?.id ?? ""), text);
            continue;
          }
          if (ev.message && (text || attachments.length > 0)) {
            const referral = ev.message.referral ?? ev.referral ?? ev.postback?.referral ?? null;
            const senderId = String(ev.sender?.id ?? "");
            await recordInboundDm(platform, senderId, text, referral, attachments);
            // Drive the chatbot flow (quick-reply taps carry a payload)
            const payload: string | undefined = ev.message.quick_reply?.payload;
            if (text || payload) await runDmFlow(platform, senderId, text, payload);
          }
        } catch (e) {
          const { logError } = await import("@/lib/errorLog");
          await logError("meta-dm-webhook", e);
        }
      }
    }
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const entries =
    (body as { entry?: { changes?: { field: string; value: Record<string, unknown> }[] }[] })
      .entry ?? [];

  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "leadgen") continue;
      const leadgenId = String(change.value?.leadgen_id ?? "");
      if (!leadgenId) continue;

      // Dedupe: Meta retries deliveries
      const existing = await prisma.lead.findUnique({ where: { externalId: leadgenId } });
      if (existing) continue;

      const accessToken = await getSetting("META_PAGE_ACCESS_TOKEN");
      try {
        if (!accessToken) throw new Error("META_PAGE_ACCESS_TOKEN not configured");
        const details = await fetchLeadDetails(leadgenId, accessToken);
        const parsed = parseLeadFields(details.field_data ?? []);
        await createIntakeLead({
          name: parsed.name ?? "New lead",
          email: parsed.email,
          phone: parsed.phone,
          model: parsed.model,
          color: parsed.color,
          message: parsed.message,
          source: metaSource(details.platform),
          externalId: leadgenId,
          raw: details,
        });
      } catch (err) {
        // Still capture a stub lead so nothing is lost; details can be filled in manually
        await createIntakeLead({
          name: "Facebook lead (details pending)",
          message: `Could not fetch lead ${leadgenId} from Graph API: ${
            err instanceof Error ? err.message : "unknown error"
          }. Check the Page Access Token in Settings.`,
          source: "facebook",
          externalId: leadgenId,
          raw: change.value,
        }).catch(() => {});
      }
    }
  }

  // Meta requires a fast 200 regardless
  return NextResponse.json({ received: true });
}

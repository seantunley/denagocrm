import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getSetting } from "@/lib/settings";
import { recordInboundWhatsApp } from "@/lib/whatsapp";

/** Meta webhook verification handshake (same flow as Lead Ads). */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");
  const verifyToken = await getSetting("META_VERIFY_TOKEN");
  if (params.get("hub.mode") === "subscribe" && token === verifyToken && challenge) {
    return new NextResponse(challenge, { status: 200 });
  }
  return new NextResponse("Verification failed", { status: 403 });
}

/** Receives WhatsApp Cloud API events (inbound customer messages). */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  const appSecret = await getSetting("META_APP_SECRET");
  if (appSecret) {
    const signature = req.headers.get("x-hub-signature-256") ?? "";
    const expected =
      "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
    const valid =
      signature.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    if (!valid) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const entries = (body as any).entry ?? [];
  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const value = change.value ?? {};
      const contactsMeta = value.contacts ?? [];
      for (const message of value.messages ?? []) {
        if (message.type !== "text") continue; // v1: text messages
        const from: string = message.from;
        const profileName: string | null =
          contactsMeta.find((c: any) => c.wa_id === from)?.profile?.name ?? null;
        await recordInboundWhatsApp(from, profileName, message.text?.body ?? "").catch(() => {});
      }
    }
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return NextResponse.json({ received: true });
}

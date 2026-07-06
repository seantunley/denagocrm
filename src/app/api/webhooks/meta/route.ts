import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { createIntakeLead } from "@/lib/leadIntake";

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

type FieldData = { name: string; values: string[] };

function pickField(fields: FieldData[], ...keys: string[]): string | null {
  for (const key of keys) {
    const f = fields.find((x) => x.name.toLowerCase().includes(key));
    if (f && f.values[0]) return f.values[0];
  }
  return null;
}

async function fetchLeadDetails(leadgenId: string, accessToken: string) {
  const res = await fetch(
    `https://graph.facebook.com/v21.0/${leadgenId}?fields=field_data,created_time,ad_name,form_id&access_token=${encodeURIComponent(
      accessToken
    )}`,
    { cache: "no-store" }
  );
  if (!res.ok) throw new Error(`Graph API ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Receives leadgen events from Facebook/Instagram Lead Ads. */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  // Verify Meta's payload signature when an app secret is configured
  const appSecret = await getSetting("META_APP_SECRET");
  if (appSecret) {
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
        const fields: FieldData[] = details.field_data ?? [];
        const name =
          pickField(fields, "full_name", "full name", "name") ?? "Facebook lead";
        await createIntakeLead({
          name,
          email: pickField(fields, "email"),
          phone: pickField(fields, "phone"),
          model: pickField(fields, "model", "product", "bike"),
          color: pickField(fields, "colour", "color"),
          message: pickField(fields, "message", "comment", "question"),
          source: "facebook",
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

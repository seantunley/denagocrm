import { NextRequest, NextResponse } from "next/server";
import { getSetting } from "@/lib/settings";

/**
 * TEMPORARY WhatsApp diagnostic. Auth: intake API key (?key=). Asks Meta about
 * the configured number + token so we can see, server-side, why real inbound
 * messages aren't arriving. Read-only — sends no messages. Remove after use.
 */
export async function GET(req: NextRequest) {
  const apiKey = await getSetting("INTAKE_API_KEY");
  const provided = req.nextUrl.searchParams.get("key");
  if (!apiKey || provided !== apiKey) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = await getSetting("WA_ACCESS_TOKEN");
  const pid = await getSetting("WA_PHONE_NUMBER_ID");
  if (!token || !pid) {
    return NextResponse.json({ error: "WhatsApp not configured", hasToken: !!token, hasPid: !!pid });
  }

  const G = "https://graph.facebook.com/v21.0";
  const t = encodeURIComponent(token);
  async function g(url: string) {
    try {
      const r = await fetch(url, { cache: "no-store" });
      return { status: r.status, body: await r.json() };
    } catch (e) {
      return { error: e instanceof Error ? e.message : "fetch failed" };
    }
  }

  const phone = await g(
    `${G}/${pid}?fields=verified_name,display_phone_number,quality_rating,platform_type,code_verification_status,name_status,is_official_business_account&access_token=${t}`
  );
  const debug = await g(`${G}/debug_token?input_token=${t}&access_token=${t}`);

  // Try to find the WABA and whether an app is subscribed to it
  let waba: { status?: number; body?: unknown; error?: string } | null = null;
  let subscribed: { status?: number; body?: unknown; error?: string } | null = null;
  const wabaProbe = await g(`${G}/${pid}?fields=whatsapp_business_account{id,name}&access_token=${t}`);
  const wabaId = (wabaProbe as { body?: { whatsapp_business_account?: { id?: string } } })?.body
    ?.whatsapp_business_account?.id;
  if (wabaId) {
    waba = wabaProbe;
    subscribed = await g(`${G}/${wabaId}/subscribed_apps?access_token=${t}`);
  }

  const d = (debug as { body?: { data?: Record<string, unknown> } })?.body?.data ?? {};
  return NextResponse.json({
    phone,
    token: {
      valid: d.is_valid ?? null,
      type: d.type ?? null,
      app_id: d.app_id ?? null,
      expires_at: d.expires_at ?? null, // 0 = never (permanent)
      scopes: d.scopes ?? null,
    },
    waba,
    subscribedApps: subscribed,
  });
}

import crypto from "crypto";
import { basePrisma } from "./db";
import { getSetting, putSetting, resolveIntegrationBundle } from "./settings";
import { currentTenantScope } from "./tenantScope";
import { sendPushToAll } from "./push";

/**
 * Pulls the most recent Google reviews via the Places API (needs only an API
 * key + place ID — no OAuth). Places returns up to the 5 newest reviews;
 * polling from the cron catches new ones as they appear. Replying happens on
 * Google Maps (deep link in the inbox) until Business Profile API access is
 * approved.
 */
export async function syncGoogleReviews(): Promise<number> {
  // Ambient tenant read for the credential lookup only — the tenantId used to
  // STAMP GOOGLE_REVIEWS_LAST_SYNC / GoogleReview rows below is a separate
  // concern owned elsewhere in this function; not touched here.
  const credentialTenantId = currentTenantScope()?.tenantId ?? null;
  const bundle = await resolveIntegrationBundle(credentialTenantId, "google-reviews");
  if (!bundle) return 0;
  const { GOOGLE_PLACES_API_KEY: apiKey, GOOGLE_PLACE_ID: placeId } = bundle;
  if (!apiKey || !placeId) return 0;

  // Reviews change slowly and this Places call bills at the expensive tier —
  // sync at most every 6 hours (~120 calls/month, inside the free allowance)
  // even though the cron fires every 15 minutes.
  const last = await getSetting("GOOGLE_REVIEWS_LAST_SYNC");
  if (last && Date.now() - new Date(last).getTime() < 6 * 60 * 60 * 1000) return 0;
  // Multi-tenancy: putSetting stamps the owning tenant. Called from inside
  // runCronPerTenant's per-tenant slice (see api/cron/automations/route.ts),
  // which sets the ambient tenant scope via runInTenantScope BEFORE invoking the
  // slice — so putSetting picks up the correct tenant. In off-mode / no scope it
  // resolves to the founding tenant (the platform-default settings owner).
  await putSetting("GOOGLE_REVIEWS_LAST_SYNC", new Date().toISOString());

  // Stamp the owning tenant on each stored review (GoogleReview.tenantId is a
  // nullable Phase-B column; null in off-mode / no scope, as before).
  const tenantId = currentTenantScope()?.tenantId ?? null;

  const res = await fetch(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?fields=reviews&key=${encodeURIComponent(apiKey)}`,
    { cache: "no-store", signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error(`Places API ${res.status}`);
  const json: {
    reviews?: {
      rating?: number;
      text?: { text?: string };
      originalText?: { text?: string };
      authorAttribution?: { displayName?: string };
      publishTime?: string;
    }[];
  } = await res.json();

  let created = 0;
  for (const r of json.reviews ?? []) {
    const author = r.authorAttribution?.displayName ?? "Anonymous";
    const publishedAt = r.publishTime ? new Date(r.publishTime) : new Date();
    const externalKey = crypto
      .createHash("sha256")
      .update(`${author}|${publishedAt.toISOString()}`)
      .digest("hex");
    const existing = await basePrisma.googleReview.findUnique({ where: { externalKey } });
    if (existing) continue;
    const review = await basePrisma.googleReview.create({
      data: {
        externalKey,
        tenantId,
        author,
        rating: Math.round(r.rating ?? 0),
        text: r.text?.text ?? r.originalText?.text ?? null,
        publishedAt,
        raw: JSON.stringify(r),
      },
    });
    created++;
    await sendPushToAll({
      title: `New Google review ${"⭐".repeat(Math.min(5, review.rating))}`,
      body: `${author}: ${(review.text ?? "").slice(0, 90) || "(no text)"}`,
      url: "/inbox",
    }, "review").catch(() => {});
  }
  return created;
}

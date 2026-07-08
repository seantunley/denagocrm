import crypto from "crypto";
import { basePrisma } from "./db";
import { getSetting } from "./settings";
import { sendPushToAll } from "./push";

/**
 * Pulls the most recent Google reviews via the Places API (needs only an API
 * key + place ID — no OAuth). Places returns up to the 5 newest reviews;
 * polling from the cron catches new ones as they appear. Replying happens on
 * Google Maps (deep link in the inbox) until Business Profile API access is
 * approved.
 */
export async function syncGoogleReviews(): Promise<number> {
  const [apiKey, placeId] = await Promise.all([
    getSetting("GOOGLE_PLACES_API_KEY"),
    getSetting("GOOGLE_PLACE_ID"),
  ]);
  if (!apiKey || !placeId) return 0;

  // Reviews change slowly and this Places call bills at the expensive tier —
  // sync at most every 6 hours (~120 calls/month, inside the free allowance)
  // even though the cron fires every 15 minutes.
  const last = await getSetting("GOOGLE_REVIEWS_LAST_SYNC");
  if (last && Date.now() - new Date(last).getTime() < 6 * 60 * 60 * 1000) return 0;
  await basePrisma.appSetting.upsert({
    where: { key: "GOOGLE_REVIEWS_LAST_SYNC" },
    update: { value: new Date().toISOString() },
    create: { key: "GOOGLE_REVIEWS_LAST_SYNC", value: new Date().toISOString() },
  });

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

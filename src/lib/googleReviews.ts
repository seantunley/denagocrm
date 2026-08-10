import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { basePrisma } from "./db";
import { DEFAULT_TENANT_ID } from "./tenant";
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
/**
 * Store one review for one tenant, or recognise it as already stored FOR THAT
 * TENANT.
 *
 * Split out of the sync loop so the property below can be exercised against a
 * real database without a Places API key. A schema test proves the composite
 * key exists; only running two tenants through this proves the runtime uses it.
 *
 * THE DEDUPE MUST NAME THE TENANT, NOT ASK WHETHER ENFORCEMENT IS ON. It used
 * `activeTenantPredicate`, which returns `{}` while enforcement is dormant — so
 * the lookup was global, and whoever synced a shared Google Place first
 * suppressed every other tenant's copy of the same review. The composite unique
 * key added by this change is the same fact stated in the database, so the
 * lookup uses it directly and cannot drift from it.
 */
export async function recordGoogleReview(input: {
  tenantId: string;
  externalKey: string;
  author: string;
  rating: number;
  text: string | null;
  publishedAt: Date;
  raw: string;
}): Promise<{ id: string; rating: number; text: string | null } | null> {
  const existing = await basePrisma.googleReview.findUnique({
    where: { tenantId_externalKey: { tenantId: input.tenantId, externalKey: input.externalKey } },
    select: { id: true },
  });
  if (existing) return null;
  try {
    return await basePrisma.googleReview.create({
      data: {
        externalKey: input.externalKey,
        tenantId: input.tenantId,
        author: input.author,
        rating: input.rating,
        text: input.text,
        publishedAt: input.publishedAt,
        raw: input.raw,
      },
      select: { id: true, rating: true, text: true },
    });
  } catch (error) {
    // Two sync runs for the same tenant racing. The constraint is the real
    // fence; the read above is only an optimisation.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return null;
    throw error;
  }
}

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

  // The tenant this sync belongs to — the SAME one the credentials came from.
  //
  // This was `writeTenantId() ?? DEFAULT_TENANT_ID`, and that is wrong here for
  // a reason specific to this function: writeTenantId deliberately returns null
  // while enforcement is dormant, so every review was stamped onto the founding
  // tenant no matter whose cron slice produced it. The slice DOES know — it runs
  // inside runInTenantScope, which is exactly where the credential lookup two
  // lines above already reads its tenant from. Reading it from a different place
  // than the credentials is how a review fetched with tenant B's Places key came
  // to be filed under tenant A.
  const tenantId = credentialTenantId ?? DEFAULT_TENANT_ID;

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
    const review = await recordGoogleReview({
      tenantId,
      externalKey,
      author,
      rating: Math.round(r.rating ?? 0),
      text: r.text?.text ?? r.originalText?.text ?? null,
      publishedAt,
      raw: JSON.stringify(r),
    });
    if (!review) continue;
    created++;
    // Named explicitly, for the same reason the review row is: the default
    // resolves to EVERY device in the table while enforcement is dormant, and
    // this payload carries a customer's words. Scoping the row and then
    // broadcasting its text would reopen the hole one line later.
    await sendPushToAll(
      {
        title: `New Google review ${"⭐".repeat(Math.min(5, review.rating))}`,
        body: `${author}: ${(review.text ?? "").slice(0, 90) || "(no text)"}`,
        url: "/inbox",
      },
      "review",
      { tenantId },
    ).catch(() => {});
  }
  return created;
}

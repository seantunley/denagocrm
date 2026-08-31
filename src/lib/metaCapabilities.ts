import "server-only";
import { getSetting, putSetting, resolveTenantCredential } from "./settings";
import { currentTenantScope } from "./tenantScope";

/**
 * What Meta has actually granted this Page token — asked, not assumed.
 *
 * ── WHY THE UI NEEDS THIS ───────────────────────────────────────────────────
 *
 * Comment ingestion needs `pages_manage_metadata` (webhook delivery) and
 * `pages_read_engagement` (reading the content). Both are granted, which is why
 * comments arrive. Writing a comment needs `pages_manage_engagement`, which is
 * NOT, and requires App Review.
 *
 * Offering a "Reply publicly" button that Meta will refuse is worse than not
 * offering one: the person writes an answer, presses send, and learns from an
 * error that the thing was never possible. So the screen asks first and shows
 * what is actually available, with the missing permission named.
 *
 * ── WHY IT IS CACHED ────────────────────────────────────────────────────────
 *
 * `me/permissions` is a network call and this is read on a page render. The
 * answer changes only when somebody changes it at Meta — App Review outcomes
 * are not minute-to-minute — so it is cached per workspace and refreshed at
 * most every few hours. A stale "yes" costs one refused send with a clear
 * message; a stale "no" costs a hidden button until the next refresh, which is
 * why {@link refreshPageCapabilities} exists for the moment somebody has just
 * granted it and wants to see the difference.
 */

const GRANTED_KEY = "META_PAGE_PERMISSIONS";
const CHECKED_KEY = "META_PAGE_PERMISSIONS_AT";
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const GRAPH = "https://graph.facebook.com/v21.0";

export type PageCapabilities = {
  /** May the CRM write a comment (public reply, hide, delete)? */
  canManageEngagement: boolean;
  /** Null when Meta has never been asked — the UI says so rather than guessing. */
  checkedAt: Date | null;
};

const UNKNOWN: PageCapabilities = { canManageEngagement: false, checkedAt: null };

/** The granted permission list, from cache, refreshing it when stale. */
export async function pageCapabilities(): Promise<PageCapabilities> {
  try {
    const checkedAtRaw = await getSetting(CHECKED_KEY);
    const checkedAt = checkedAtRaw ? new Date(checkedAtRaw) : null;
    const fresh = checkedAt !== null && Date.now() - checkedAt.getTime() < MAX_AGE_MS;

    if (fresh) {
      const granted = (await getSetting(GRANTED_KEY)) ?? "";
      return { canManageEngagement: granted.split(",").includes("pages_manage_engagement"), checkedAt };
    }

    return await refreshPageCapabilities();
  } catch {
    // A capability probe must never break the screen it informs.
    return UNKNOWN;
  }
}

/**
 * Ask Meta now and store the answer.
 *
 * Separate from the cached read so that granting the permission and coming back
 * to the screen does not mean waiting out a cache window.
 */
export async function refreshPageCapabilities(): Promise<PageCapabilities> {
  try {
    const token = await resolveTenantCredential(
      currentTenantScope()?.tenantId ?? null,
      "META_PAGE_ACCESS_TOKEN",
    );
    if (!token) return UNKNOWN;

    const res = await fetch(`${GRAPH}/me/permissions?access_token=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return UNKNOWN;
    const body = (await res.json()) as { data?: Array<{ permission?: string; status?: string }> };

    // "declined" and "expired" both appear in this list. Only "granted" counts.
    const granted = (body.data ?? [])
      .filter((row) => row.status === "granted" && row.permission)
      .map((row) => String(row.permission));

    const checkedAt = new Date();
    await putSetting(GRANTED_KEY, granted.join(","));
    await putSetting(CHECKED_KEY, checkedAt.toISOString());

    return { canManageEngagement: granted.includes("pages_manage_engagement"), checkedAt };
  } catch {
    return UNKNOWN;
  }
}

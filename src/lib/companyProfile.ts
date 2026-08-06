import "server-only";
import { getSetting } from "./settings";
import { getActiveTenantId } from "./auth";
import { brandForTenant, brandLogoUrl } from "./tenantBrand";
import { appBaseUrl } from "./campaigns";
import { COMPANY_DEFAULTS, COMPANY_KEYS, type CompanyProfile } from "./companyBrand";

/**
 * Single source of truth for the company's own details — name, contact info and
 * socials — used by every document's {{company.*}} merge tokens and the branded
 * footer. Stored in AppSetting; falls back to the current values so nothing
 * changes until an owner edits the profile.
 *
 * The pure constants/tokens live in `companyBrand.ts` (client-safe) so the
 * document-editor canvas can preview the brand footer; only the DB-backed
 * `getCompanyProfile()` below needs `server-only`.
 */
export type { CompanyProfile } from "./companyBrand";
export { COMPANY_DEFAULTS, COMPANY_KEYS, companyTokens } from "./companyBrand";

/**
 * ONE resolution order for the company a document is FROM, in three steps:
 *
 *   1. the tenant's OWN Company Profile (AppSetting, per-tenant since
 *      20260727190000_appsetting_pk_composite) — set by their own admin, and the
 *      only source that carries an address, phone, email and socials;
 *   2. the PLATFORM-set tenant brand (Tenant.brandDisplayName / brandLogoRef) —
 *      set by a platform admin in the console;
 *   3. the built-in defaults.
 *
 * Step 2 is what this adds, and it exists to stop there being two logos. Before
 * it, a platform admin could brand a tenant's app and login pages while every
 * document they printed still carried the Denago mark, because documents read
 * the Company Profile and nothing joined the two. A tenant would have had to
 * upload the same logo twice, in two places, and the two could drift.
 *
 * Own-profile-first is the right precedence: the tenant's admin knows their
 * trading name and address better than the platform admin does, and the profile
 * is the only one of the three that can express them at all.
 */
export async function getCompanyProfile(): Promise<CompanyProfile> {
  const fields = Object.keys(COMPANY_KEYS) as (keyof CompanyProfile)[];
  const [entries, tenantBrand] = await Promise.all([
    Promise.all(
      fields.map(async (field) => {
        const value = (await getSetting(COMPANY_KEYS[field]))?.trim();
        return [field, value && value.length ? value : ""] as const;
      }),
    ),
    // Never throws, and returns DEFAULT_BRAND when nothing is set — so with no
    // tenant brand configured this whole branch contributes nothing and the
    // result is byte-for-byte the old COMPANY_DEFAULTS fallback.
    brandForTenant(await getActiveTenantId().catch(() => null)).catch(() => null),
  ]);

  const fromBrand: Partial<Record<keyof CompanyProfile, string>> = tenantBrand?.tenantId
    ? {
        name: tenantBrand.displayName,
        tagline: tenantBrand.tagline ?? "",
        // Absolute: this URL is embedded in printed HTML and in emailed
        // signatures, neither of which has an origin to resolve a path against.
        logoUrl: brandLogoUrl(tenantBrand) ? `${appBaseUrl()}${brandLogoUrl(tenantBrand)}` : "",
      }
    : {};

  return Object.fromEntries(
    entries.map(([field, own]) => [field, own || fromBrand[field] || COMPANY_DEFAULTS[field]]),
  ) as CompanyProfile;
}

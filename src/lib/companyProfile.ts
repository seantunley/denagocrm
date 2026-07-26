import "server-only";
import { getSetting } from "./settings";
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

export async function getCompanyProfile(): Promise<CompanyProfile> {
  const fields = Object.keys(COMPANY_KEYS) as (keyof CompanyProfile)[];
  const entries = await Promise.all(
    fields.map(async (field) => {
      const value = (await getSetting(COMPANY_KEYS[field]))?.trim();
      return [field, value && value.length ? value : COMPANY_DEFAULTS[field]] as const;
    }),
  );
  return Object.fromEntries(entries) as CompanyProfile;
}

import "server-only";
import { getSetting } from "./settings";

/**
 * Single source of truth for the company's own details — name, contact info and
 * socials — used by every document's {{company.*}} merge tokens and the branded
 * footer. Stored in AppSetting; falls back to the current values so nothing
 * changes until an owner edits the profile.
 */
export type CompanyProfile = {
  name: string;
  tagline: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  facebook: string;
  instagram: string;
  logoUrl: string;
};

export const COMPANY_DEFAULTS: CompanyProfile = {
  name: "Denago Cape Town",
  tagline: "Authorized Denago EV Dealer",
  address: "Unit 55, M5 Freeway Business Park, Maitland, Cape Town",
  phone: "073 789 3438",
  email: "sales@denagocpt.co.za",
  website: "denagocpt.co.za",
  facebook: "",
  instagram: "@denago_capetown",
  logoUrl: "",
};

export const COMPANY_KEYS: Record<keyof CompanyProfile, string> = {
  name: "COMPANY_NAME",
  tagline: "COMPANY_TAGLINE",
  address: "COMPANY_ADDRESS",
  phone: "COMPANY_PHONE",
  email: "COMPANY_EMAIL",
  website: "COMPANY_WEBSITE",
  facebook: "COMPANY_FACEBOOK",
  instagram: "COMPANY_INSTAGRAM",
  logoUrl: "COMPANY_LOGO_URL",
};

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

/** The {{company.*}} merge tokens used in document rendering. */
export function companyTokens(p: CompanyProfile): Record<string, string> {
  return {
    "company.name": p.name,
    "company.tagline": p.tagline,
    "company.address": p.address,
    "company.phone": p.phone,
    "company.email": p.email,
    "company.website": p.website,
    "company.facebook": p.facebook,
    "company.instagram": p.instagram,
  };
}

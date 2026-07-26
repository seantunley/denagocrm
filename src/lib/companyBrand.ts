/**
 * Client-safe company brand constants, shared by the document editor canvas
 * (a live preview that runs in the browser) and the server-side renderers.
 *
 * The DB-backed `getCompanyProfile()` stays in `companyProfile.ts` (server-only,
 * it reads AppSetting); everything here is pure data with no server imports so
 * the editor's `BlockView` can render the brand footer with real default values.
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

/** Facebook / Instagram glyph paths on a 24×24 viewBox, for the brand footer. */
export const SOCIAL_ICON_PATHS: Record<"facebook" | "instagram", string> = {
  facebook:
    "M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z",
  instagram:
    "M12 2.163c3.204 0 3.584.012 4.85.07 1.366.062 2.633.334 3.608 1.309.975.975 1.247 2.242 1.309 3.608.058 1.266.07 1.646.07 4.85s-.012 3.584-.07 4.85c-.062 1.366-.334 2.633-1.309 3.608-.975.975-2.242 1.247-3.608 1.309-1.266.058-1.646.07-4.85.07s-3.584-.012-4.85-.07c-1.366-.062-2.633-.334-3.608-1.309-.975-.975-1.247-2.242-1.309-3.608-.058-1.266-.07-1.646-.07-4.85s.012-3.584.07-4.85c.062-1.366.334-2.633 1.309-3.608.975-.975 2.242-1.247 3.608-1.309 1.266-.058 1.646-.07 4.85-.07M12 0C8.741 0 8.332.015 7.052.072 5.197.157 3.355.673 2.014 2.014.673 3.355.157 5.197.072 7.052.015 8.332 0 8.741 0 12s.015 3.668.072 4.948c.085 1.855.601 3.697 1.942 5.038 1.341 1.341 3.183 1.857 5.038 1.942C8.332 23.988 8.741 24 12 24s3.668-.012 4.948-.072c1.855-.085 3.697-.601 5.038-1.942 1.341-1.341 1.857-3.183 1.942-5.038.057-1.28.072-1.689.072-4.948s-.015-3.668-.072-4.948c-.085-1.855-.601-3.697-1.942-5.038C20.645.673 18.803.157 16.948.072 15.668.015 15.259 0 12 0m0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324M12 16a4 4 0 110-8 4 4 0 010 8m6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881",
};

/**
 * Build the three text rows and social handle of the brand footer from a field
 * getter — live {{company.*}} tokens at render time, or COMPANY_DEFAULTS in the
 * editor canvas. Empty fields are dropped so the separators never dangle.
 */
export function brandFooterContent(get: (key: keyof CompanyProfile) => string) {
  const v = (k: keyof CompanyProfile) => (get(k) ?? "").trim();
  const joinDot = (...parts: string[]) => parts.filter(Boolean).join(" · ");
  const name = v("name");
  const tagline = v("tagline");
  return {
    title: tagline ? `${name} — ${tagline}` : name,
    contact: joinDot(v("address"), v("phone")),
    web: joinDot(v("email"), v("website")),
    instagram: v("instagram"),
  };
}

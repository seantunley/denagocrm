import "server-only";
import { brandForTenant, brandLogoUrl, DEFAULT_BRAND } from "./tenantBrand";
import { tenantOrigin } from "./tenantOrigin";

/**
 * Brand for an EMAIL, which is a different problem from brand for a page.
 *
 * BRANDING-ROADMAP.md flagged the constraint: *"Email cannot use CSS variables.
 * Most mail clients ignore custom properties, so email templates need inline
 * styles and an absolute logo URL."* Two consequences:
 *
 *  - The logo URL must be ABSOLUTE. A mail client has no origin to resolve
 *    `/api/brand/logo/…` against, so it is prefixed with the app's base URL.
 *    That route is public, which is what makes this work at all — an image in an
 *    email is fetched by the recipient's client, with no session.
 *  - There is no accent to inline. The campaign shell's header bar is a fixed
 *    dark slate, not the brand colour, so logo + name + footer is the whole job.
 *    Introducing an accent into email would mean inlining it at every use, which
 *    is a bigger change than this phase is.
 *
 * The SENDER identity is already per-tenant and is NOT this module's job:
 * getSmtpConfig resolves SMTP_FROM through resolveIntegrationBundle for the
 * current tenant scope, so a tenant that has configured its own SMTP already
 * sends as itself. What was still Denago's was the picture and the footer.
 */

export type EmailBrand = {
  branded: boolean;
  displayName: string;
  /** Absolute, or null to use the built-in asset. */
  logoUrl: string | null;
  tagline: string | null;
};

export const UNBRANDED_EMAIL: EmailBrand = {
  branded: false,
  displayName: DEFAULT_BRAND.displayName,
  logoUrl: null,
  tagline: null,
};

/**
 * Never throws. A campaign send that failed because a logo could not be looked
 * up would be a marketing run lost to decoration — and unlike a page, there is
 * no error boundary and no retry the recipient can trigger.
 */
export async function emailBrand(tenantId: string | null | undefined): Promise<EmailBrand> {
  if (!tenantId) return UNBRANDED_EMAIL;
  try {
    const brand = await brandForTenant(tenantId);
    if (!brand.tenantId) return UNBRANDED_EMAIL;
    const relative = brandLogoUrl(brand);
    return {
      branded: true,
      displayName: brand.displayName,
      // The tenant's own origin. Same route, same bytes, same deployment — the
      // only thing that changes is the hostname a recipient sees when their mail
      // client asks whether to load remote images.
      logoUrl: relative ? `${await tenantOrigin(tenantId)}${relative}` : null,
      tagline: brand.tagline,
    };
  } catch {
    return UNBRANDED_EMAIL;
  }
}

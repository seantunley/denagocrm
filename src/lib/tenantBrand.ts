import { cache } from "react";
import { basePrisma } from "./db";

/**
 * WHOSE BRAND DOES THIS REQUEST RENDER?
 *
 * Every other surface in the app can answer that from something it already has —
 * the CRM from a session, the portal from a contact, signing/survey/approval
 * pages from a token. The LOGIN pages have none of those, and that is not an
 * oversight: working out who you are is what they are for. With per-tenant
 * domains there is exactly one signal available before authentication, the
 * hostname the request arrived on, and this module is the only thing that turns
 * it into a brand.
 *
 * ── Three properties this module must have, in order ────────────────────────
 *
 * 1. IT MUST NOT THROW. It runs on `/login`. A brand lookup that raises takes
 *    the sign-in page down, and a sign-in page that is down is a lockout of the
 *    whole workspace — for a decorative feature. Every failure path returns
 *    DEFAULT_BRAND. There is no error case that is worth more than being able to
 *    log in.
 *
 * 2. IT MUST FAIL TO TODAY'S OUTPUT, not to blank. An unknown hostname, an
 *    unverified domain, a suspended tenant, a database that is briefly
 *    unreachable — all produce exactly what the app rendered before branding
 *    existed. The first visible change anywhere is a platform admin filling in
 *    the form.
 *
 * 3. THE COLOUR IS UNTRUSTED AT BOTH ENDS. `brandPrimary` is interpolated into a
 *    stylesheet, so it is validated on write AND again here on read. A value
 *    that somehow reached the column — a bad migration, a direct SQL edit, a
 *    future writer that forgets — still cannot reach the page.
 *
 * ── Why basePrisma ──────────────────────────────────────────────────────────
 *
 * This read happens BEFORE any tenant scope exists, so the scoped client would
 * fail closed under enforcement. `basePrisma` sets `app.bypass_rls='on'` for
 * model ops and for all four raw methods (db.ts `buildBypassClient`), so the
 * lookup keeps working under the restricted, non-BYPASSRLS role the RLS work is
 * heading for — rather than working by accident because the app role still
 * carries `rolbypassrls` today.
 *
 * The query is narrow on purpose: it returns branding and a tenant id, nothing
 * else. It is reachable unauthenticated by anyone who can resolve the hostname,
 * so it must not become a way to read anything that address does not already
 * display.
 */

export type TenantBrand = {
  /** The tenant this hostname belongs to, or null when it resolved to nobody. */
  tenantId: string | null;
  /** What replaces "Denago Cape Town" in headings, footers and page copy. */
  displayName: string;
  /** The line under it. Null renders nothing rather than an empty element. */
  tagline: string | null;
  /**
   * Accent colour as `#rrggbb`, or NULL meaning "do not override" — the app's
   * own `--primary` stands. Null is not a colour; callers must not substitute
   * one, because the default already lives in globals.css.
   */
  primary: string | null;
  /** Readable text on `primary`. Computed, never stored — see textOn(). */
  primaryForeground: string | null;
  /** Blob pathname for the logo, or null to use the built-in asset. */
  logoRef: string | null;
};

/**
 * What every surface rendered before branding existed.
 *
 * DELIBERATELY the current Denago values rather than a neutral platform
 * identity. Making the fallback neutral is the right end state for a white-label
 * platform — an unrecognised hostname should not show one customer's brand to
 * another's visitors — but it CANNOT ship in the same change as the schema,
 * because until Denago's own hostnames are registered in TenantDomain the live
 * workspace resolves to nobody and would rebrand itself to "neutral" the moment
 * this deploys. That is a visible production change, and this change is required
 * to have none.
 *
 * Sequence: ship this, register Denago's domains through the console, confirm
 * the live login still says what it says today, and only THEN switch this
 * constant to the neutral shell. That final step is a one-line change with the
 * safety net already in place.
 */
export const DEFAULT_BRAND: TenantBrand = {
  tenantId: null,
  displayName: "Denago Cape Town",
  tagline: "Authorized Denago EV Dealer",
  primary: null,
  primaryForeground: null,
  logoRef: null,
};

/** `#rrggbb` and nothing else. Not a lint — this string reaches a stylesheet. */
const HEX = /^#[0-9a-fA-F]{6}$/;

export function isBrandColour(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

/**
 * Readable text on a background, by relative luminance (WCAG 2.x).
 *
 * COMPUTED, NEVER STORED. Storing a foreground alongside the accent is an
 * invitation to white-on-yellow: two fields that must agree, set by someone who
 * is not looking at the result. One colour in, legible text guaranteed.
 *
 * The 0.5 threshold is the conventional split for #000/#fff against sRGB and is
 * what the roadmap's "compute it from luminance" means in practice.
 */
export function textOn(hex: string): "#ffffff" | "#0f172a" {
  const channel = (start: number) => {
    const raw = parseInt(hex.slice(start, start + 2), 16) / 255;
    return raw <= 0.03928 ? raw / 12.92 : Math.pow((raw + 0.055) / 1.055, 2.4);
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  // Slate-900 rather than pure black: it is the app's own ink colour, so a light
  // accent reads as part of the design rather than as a hole in it.
  return luminance > 0.5 ? "#0f172a" : "#ffffff";
}

/**
 * Lower-case, strip the port, strip a trailing dot.
 *
 * Applied to BOTH the stored hostname and the looked-up one, so "ACME.co.za:443"
 * and "acme.co.za" cannot become two rows pointing at different tenants — which
 * would make "whose brand is this?" depend on which row was written first.
 *
 * IPv6 literals arrive bracketed (`[::1]:3000`); the bracket form is preserved
 * and only the trailing port removed, so they round-trip rather than being
 * mangled into something that matches nothing.
 */
export function normaliseHost(host: string | null | undefined): string | null {
  if (typeof host !== "string") return null;
  let value = host.trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close > 0) value = value.slice(0, close + 1);
  } else {
    const colon = value.indexOf(":");
    if (colon >= 0) value = value.slice(0, colon);
  }
  if (value.endsWith(".")) value = value.slice(0, -1);
  return value || null;
}

type BrandRow = {
  tenantId: string;
  brandPrimary: string | null;
  brandLogoRef: string | null;
  brandDisplayName: string | null;
  brandTagline: string | null;
};

/** Turn a row into a brand, applying the read-side colour validation. */
export function brandFromRow(row: BrandRow): TenantBrand {
  // Validated AGAIN here, not just on write. A colour that reached the column by
  // any route other than the console form still cannot reach the stylesheet.
  const primary = isBrandColour(row.brandPrimary) ? row.brandPrimary : null;
  return {
    tenantId: row.tenantId,
    // A blank string is not a name. Treated exactly like null so an admin who
    // clears the field gets the default back rather than an empty heading.
    displayName: row.brandDisplayName?.trim() || DEFAULT_BRAND.displayName,
    tagline: row.brandTagline?.trim() || DEFAULT_BRAND.tagline,
    primary,
    primaryForeground: primary ? textOn(primary) : null,
    logoRef: row.brandLogoRef?.trim() || null,
  };
}

/**
 * The brand for a hostname. Never throws; never returns null.
 *
 * `cache()` per request, the same treatment `getEnabledModuleIds` gets, because a
 * layout and a page in the same render both want it and it must not be two
 * queries.
 */
export const brandForHost = cache(async (host: string | null | undefined): Promise<TenantBrand> => {
  const hostname = normaliseHost(host);
  if (!hostname) return DEFAULT_BRAND;
  try {
    const row = await basePrisma.tenantDomain.findFirst({
      where: {
        hostname,
        // NOT NULL is the whole point: an unverified domain is a hostname
        // somebody CLAIMED, and honouring it would let a tenant put their brand
        // on an address they do not control.
        verifiedAt: { not: null },
        tenant: { active: true },
      },
      select: {
        tenantId: true,
        tenant: {
          select: {
            brandPrimary: true,
            brandLogoRef: true,
            brandDisplayName: true,
            brandTagline: true,
          },
        },
      },
    });
    if (!row?.tenant) return DEFAULT_BRAND;
    return brandFromRow({ tenantId: row.tenantId, ...row.tenant });
  } catch {
    // Deliberately silent and deliberately total. This runs on the sign-in page;
    // a database blip must cost the workspace its accent colour, never its
    // ability to log in. Nothing here is worth an error boundary.
    return DEFAULT_BRAND;
  }
});

/**
 * The brand for a tenant we already know — the SIGNED-IN case.
 *
 * The counterpart to brandForHost. Inside the app there is a session, so the
 * tenant is already resolved and the hostname is irrelevant: a staff member who
 * reaches the CRM on the platform's own domain must still see their own brand.
 * Resolving by hostname there would show them the default.
 *
 * Same guarantees as brandForHost — never throws, falls back to DEFAULT_BRAND,
 * validates the colour on read, reads through basePrisma so it survives the
 * restricted role. `cache()` because the layout renders it on every navigation.
 */
export const brandForTenant = cache(async (tenantId: string | null | undefined): Promise<TenantBrand> => {
  if (!tenantId) return DEFAULT_BRAND;
  try {
    const tenant = await basePrisma.tenant.findFirst({
      where: { id: tenantId, active: true },
      select: {
        brandPrimary: true,
        brandLogoRef: true,
        brandDisplayName: true,
        brandTagline: true,
      },
    });
    if (!tenant) return DEFAULT_BRAND;
    return brandFromRow({ tenantId, ...tenant });
  } catch {
    // The CRM shell wraps every page in the app. A brand lookup that raised here
    // would take the whole workspace down, not one screen.
    return DEFAULT_BRAND;
  }
});

/**
 * The `<style>` body that applies a brand, or null when there is nothing to
 * apply.
 *
 * Null rather than an empty string so a caller renders NO element at all for an
 * unbranded tenant — byte-for-byte the markup that shipped before this feature.
 *
 * Safe to inline: `src/lib/csp.ts` sets `style-src 'self' 'unsafe-inline'`
 * (documented there — ~205 inline style attributes make a nonce-only policy a
 * 41-file rewrite), and both values are re-validated above, so the only
 * characters that can reach this string are `#` and six hex digits.
 */
export function brandStyle(brand: TenantBrand): string | null {
  if (!brand.primary || !brand.primaryForeground) return null;
  return `:root{--primary:${brand.primary};--primary-foreground:${brand.primaryForeground}}`;
}

/**
 * The URL a page renders for the tenant's logo, or null to use the built-in
 * asset. Served by /api/brand/logo/[tenantId] (public — its consumer is the
 * login page). The `v` parameter is derived from the ref, which is timestamped
 * on every upload, so the route's `immutable` cache header is honest: a given
 * URL's bytes never change, and a new upload is a new URL.
 */
export function brandLogoUrl(brand: TenantBrand): string | null {
  if (!brand.tenantId || !brand.logoRef) return null;
  let hash = 0;
  for (let i = 0; i < brand.logoRef.length; i++) {
    hash = (hash * 31 + brand.logoRef.charCodeAt(i)) | 0;
  }
  return `/api/brand/logo/${brand.tenantId}?v=${(hash >>> 0).toString(36)}`;
}

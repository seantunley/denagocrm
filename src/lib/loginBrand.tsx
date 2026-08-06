import { headers } from "next/headers";
import { brandForHost, brandLogoUrl, brandStyle, type TenantBrand } from "./tenantBrand";

/**
 * The brand for a LOGIN page, resolved from the hostname the request arrived on.
 *
 * Every other surface in this app can name its tenant from something it already
 * holds — the CRM from a session, the portal from a contact, signing and survey
 * pages from a token. The login pages hold none of that, because working out who
 * you are is what they are for. With per-tenant domains the hostname is the only
 * signal that exists before authentication, and this is the one place that turns
 * it into something a page can render.
 *
 * ── The safety rule this module exists to keep ──────────────────────────────
 *
 * A LOGIN PAGE THAT FAILS IS A LOCKOUT OF THE ENTIRE WORKSPACE. Branding is
 * decoration; signing in is not. So there is no failure path here that produces
 * anything other than a page: `brandForHost` already swallows every database
 * error, and `headers()` is read inside the same try so that a request-scope
 * problem cannot escape either. The worst outcome available is "the login page
 * renders unbranded", which is exactly what it renders today.
 *
 * ── Why unbranded output is byte-identical ──────────────────────────────────
 *
 * `branded` is false whenever no tenant resolved, which is every request until a
 * platform admin registers and verifies a hostname. The client components below
 * are written so that `branded === false` takes the original literal in every
 * single case — not a computed value that happens to equal it. That is what makes
 * "nothing changes when this merges" checkable rather than hopeful, and
 * tests/loginBranding.test.ts checks it.
 */

/** Exactly what a login page needs. Serialisable — it crosses to a client component. */
export type LoginBrand = {
  /** False until a verified hostname resolves. Every substitution is gated on it. */
  branded: boolean;
  /** The tenant's name, or the platform default when nothing resolved. */
  displayName: string;
  tagline: string | null;
  /** URL for the tenant's logo, or null to render the built-in asset. */
  logoUrl: string | null;
  /** `:root{…}` accent override, or null to emit no style element at all. */
  style: string | null;
};

export const UNBRANDED: LoginBrand = {
  branded: false,
  displayName: "Denago Cape Town",
  tagline: null,
  logoUrl: null,
  style: null,
};

export function toLoginBrand(brand: TenantBrand): LoginBrand {
  // `tenantId` is the honest test for "a verified hostname resolved to somebody".
  // Checking displayName instead would treat the DEFAULT brand as branded.
  if (!brand.tenantId) return UNBRANDED;
  return {
    branded: true,
    displayName: brand.displayName,
    tagline: brand.tagline,
    logoUrl: brandLogoUrl(brand),
    style: brandStyle(brand),
  };
}

/**
 * Resolve the brand for the current request. Never throws, never returns null.
 *
 * `headers()` is async in this version of Next (see
 * node_modules/next/dist/docs/01-app/03-api-reference/04-functions/headers.md)
 * and reading it opts the route into dynamic rendering — which costs nothing
 * here, because the root layout already forces dynamic rendering everywhere for
 * nonce-based CSP. There is no static variant of these pages to be served to the
 * wrong tenant.
 */
export async function loginBrand(): Promise<LoginBrand> {
  try {
    const host = (await headers()).get("host");
    return toLoginBrand(await brandForHost(host));
  } catch {
    return UNBRANDED;
  }
}

/**
 * The accent override, or nothing.
 *
 * Rendering `null` emits NO element, so an unbranded login page's markup is
 * byte-for-byte what it was before branding existed. Inline `<style>` is
 * permitted by the app's CSP (`style-src 'self' 'unsafe-inline'`, documented in
 * lib/csp.ts), and both interpolated values are re-validated hex in
 * tenantBrand.ts — the only characters that can reach here are `#` and hex
 * digits.
 */
export function BrandStyle({ brand }: { brand: LoginBrand }) {
  if (!brand.style) return null;
  return <style>{brand.style}</style>;
}

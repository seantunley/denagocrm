import { basePrisma } from "./db";
import { brandFromRow, type TenantBrand } from "./tenantBrand";
import { PLATFORM_URL } from "./platformLegal";

/*
 * A WORKSPACE'S OWN SIGN-IN LINK (Sean, 2026-11-24: Fourbuy's logo "is not on the login screen"). The sign-in page
 * knows a workspace only by the address it is opened on, so a workspace with no domain of its own got the platform's
 * page. `/login?w=<slug>` names it — but ONLY on an address that belongs to no workspace: a slug can never put one
 * workspace's brand on another's domain.
 *
 * What it shows is what the workspace's own domain would show anyone: its name, logo, colour and sign-in look.
 */

export const SIGN_IN_WORKSPACE_PARAM = "w";
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The active workspace a sign-in link names, with its sign-in look; null for anything else. Never throws. */
export async function brandForSignInSlug(slug: unknown): Promise<TenantBrand | null> {
  if (typeof slug !== "string" || !SLUG.test(slug)) return null;
  try {
    const row = await basePrisma.tenant.findFirst({
      where: { slug, active: true },
      select: { id: true, name: true, brandPrimary: true, brandLogoRef: true, brandDisplayName: true, brandTagline: true, loginJson: true },
    });
    if (!row) return null;
    const { id, name, ...brand } = row;
    // No display name set: the workspace's own name, never the platform's.
    return brandFromRow({ tenantId: id, ...brand, brandDisplayName: brand.brandDisplayName?.trim() || name });
  } catch {
    return null;
  }
}

/**
 * The link a workspace's team signs in on: its own domain when it has one, else the PLATFORM's own address naming it
 * — never the app's base URL, which can be another workspace's domain (where the slug is ignored, by design).
 */
export async function signInLinkFor(tenant: { id: string; slug: string }): Promise<string> {
  const domain = await basePrisma.tenantDomain.findFirst({
    where: { tenantId: tenant.id, verifiedAt: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { hostname: true },
  });
  return domain ? `https://${domain.hostname}/login` : `${PLATFORM_URL}/login?${SIGN_IN_WORKSPACE_PARAM}=${encodeURIComponent(tenant.slug)}`;
}

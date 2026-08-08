import "server-only";
import { cache } from "react";
import { basePrisma } from "./db";
import { appBaseUrl } from "./campaigns";

/**
 * THE ORIGIN A TENANT'S OUTBOUND LINKS AND IMAGES SHOULD USE.
 *
 * The tracked gap was narrow — "the email signature's social glyphs still load
 * from the platform's host, visible to recipients in load-remote-images" — and
 * the note filed with it guessed at the fix: per-tenant asset hosting.
 *
 * There is no asset-hosting problem. Every tenant domain is attached to the SAME
 * Vercel deployment, which is what makes per-tenant login pages work at all. So
 * https://acme-crm.co.za/branding/social-facebook.png already resolves, right
 * now, serving the same bytes from the same public/ directory. Nothing needs to
 * be hosted anywhere new.
 *
 * What was wrong was the BASE URL. Every outbound absolute URL in the app was
 * built from NEXT_PUBLIC_APP_URL — one constant, the platform's own hostname —
 * so a tenant's own domain was used for the browser and never for anything the
 * app sent out. That is a much bigger surface than three glyphs:
 *
 *   - the "click here to sign" link in a signature request
 *   - survey invitations
 *   - every click-tracked link and the unsubscribe URL in a campaign
 *   - the logo in a campaign email and in an email signature
 *
 * A customer of Acme who is asked to sign a document gets a link to
 * crm.denagocpt.co.za. The glyphs were the least visible thing on the list.
 *
 * ── Old links must keep working. Forever. ───────────────────────────────────
 *
 * A signing link emailed last month has the platform host baked into it, and it
 * may be the only copy the signer has. So this changes where NEW links point and
 * nothing else: no redirect, no canonicalisation, no host check on the way in.
 * The platform origin stays a permanently valid way to reach every route. That
 * is not a transitional allowance — it is the design.
 *
 * ── Why the earliest verified domain ────────────────────────────────────────
 *
 * TenantDomain has no "primary" flag, and adding one would be another field for
 * a platform admin to get wrong. The earliest verified hostname is deterministic,
 * needs no schema change, and matches what actually happens: the first domain
 * someone sets up is the one they use.
 */

/** Never throws. A link that cannot resolve a tenant origin uses the platform's. */
export const tenantOrigin = cache(async (tenantId: string | null | undefined): Promise<string> => {
  const fallback = appBaseUrl();
  if (!tenantId) return fallback;
  try {
    // basePrisma: this is called from cron jobs, queue workers and token-scoped
    // public routes, which have no tenant scope of their own — and the row it
    // reads is a hostname, not customer data.
    const domain = await basePrisma.tenantDomain.findFirst({
      where: { tenantId, verifiedAt: { not: null }, tenant: { active: true } },
      orderBy: { createdAt: "asc" },
      select: { hostname: true },
    });
    return domain?.hostname ? `https://${domain.hostname}` : fallback;
  } catch {
    return fallback;
  }
});

/**
 * Every hostname that is a legitimate origin for this deployment.
 *
 * Used by the PDF renderer's image allow-list. Once a document's logo URL is
 * built from a tenant origin, a renderer that only trusts NEXT_PUBLIC_APP_URL
 * silently drops it — and a PDF with no logo is generated, stored and emailed
 * without anything failing. Same bytes, same deployment, different name on the
 * front, so trusting them is not a widening of what can be fetched.
 */
export const verifiedTenantHosts = cache(async (): Promise<string[]> => {
  try {
    const rows = await basePrisma.tenantDomain.findMany({
      where: { verifiedAt: { not: null }, tenant: { active: true } },
      select: { hostname: true },
    });
    return rows.map((r) => r.hostname.toLowerCase());
  } catch {
    return [];
  }
});

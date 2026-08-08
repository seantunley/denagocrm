import type { CompanyProfile } from "@/lib/companyBrand";
import { companyTokens } from "@/lib/companyBrand";

/**
 * THE BRAND A SIGNED DOCUMENT KEEPS.
 *
 * `SignatureRequest.snapshotJson` freezes the DOCUMENT a signature is evidence
 * of, so that editing a template cannot retroactively change what a customer
 * already agreed to. This freezes who that document says it is FROM, for exactly
 * the same reason and at exactly the same moment.
 *
 * ── What was actually at risk ───────────────────────────────────────────────
 *
 * NOT the sealed PDF. That is bytes in blob storage with a sha-256 beside it in
 * `signedPdfHash`; nothing rewrites it, and the Q-1010 work made that explicit.
 *
 * What was at risk is every RE-RENDER of the snapshot — the print view of a
 * signed quote, the signing-hub preview, a regenerated copy. Those resolved
 * `{{company.*}}` live, so a rebrand would have made them show a different
 * company's name and logo above the same clauses and the same signatures. The
 * sealed artifact and the views that claim to depict it would have disagreed,
 * with nothing on either to say which was authoritative. That is worse than
 * either being wrong alone.
 *
 * ── Why the logo is a URL and not the bytes ─────────────────────────────────
 *
 * The tenant logo URL is content-addressed — /api/brand/logo/[tenantId]?v=<hash
 * of the blob ref> — and the ref is timestamped on every upload, so a NEW logo
 * is a new URL and this frozen one keeps pointing at the old object. Storing the
 * bytes would put ~20 KB of base64 on every signature request to defend against
 * the one case the URL does not cover: a tenant DELETING the logo, after which
 * the frozen URL 404s.
 *
 * That trade is deliberate. A missing image in a convenience re-render is
 * degradation; the sealed PDF still carries the logo as issued. Silently
 * printing a DIFFERENT company's logo is misrepresentation. Only the second is
 * worth preventing at any cost, and the URL prevents it.
 */

export type FrozenBrand = {
  /** The {{company.*}} tokens exactly as resolved at send time. */
  tokens: Record<string, string>;
  /** Absolute logo URL as at send time, or null to use the built-in asset. */
  logoUrl: string | null;
};

export function frozenBrand(profile: CompanyProfile): FrozenBrand {
  return {
    tokens: companyTokens(profile),
    logoUrl: profile.logoUrl?.trim() || null,
  };
}

/**
 * Read a stored `brandJson` back, defensively.
 *
 * Returns null for anything that is not a brand this module wrote — null (every
 * row predating the column), a legacy shape, or a value that has been corrupted.
 * Null means "resolve live", which is what those rows have always done, so a
 * bad value degrades to today's behaviour rather than to a broken document.
 */
export function parseFrozenBrand(value: unknown): FrozenBrand | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { tokens?: unknown; logoUrl?: unknown };
  if (!candidate.tokens || typeof candidate.tokens !== "object") return null;
  const tokens: Record<string, string> = {};
  for (const [key, raw] of Object.entries(candidate.tokens as Record<string, unknown>)) {
    if (typeof raw === "string") tokens[key] = raw;
  }
  // A brand with no tokens at all is not a brand — fall back rather than render
  // a document whose every {{company.*}} placeholder resolves to nothing.
  if (Object.keys(tokens).length === 0) return null;
  return {
    tokens,
    logoUrl: typeof candidate.logoUrl === "string" && candidate.logoUrl.trim() ? candidate.logoUrl : null,
  };
}

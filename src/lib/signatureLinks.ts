/**
 * Counting clicks on the links in email signatures (Sean, 2026-11-20 — item 11 of email-signature-improvements.md:
 * "Banner clicks are tracked. Do the same for the phone, WhatsApp, website and social links"). Pure: which links are
 * counted, what kind each is, and the rewrite. The store is lib/signatureLinkStore.ts; the click route /api/track/s.
 *
 * Web links only. A phone or email link (tel:, mailto:) opens an app on the reader's device; sent through a web page
 * first it would open a browser tab, or not work at all in some mail apps — so those are left alone, and the page
 * says so.
 */

/** A link token: what /api/track/s/<token> accepts. */
export const SIGNATURE_LINK_REF = /^[A-Za-z0-9_-]{24,64}$/;

export const SIGNATURE_LINK_KINDS = ["website", "whatsapp", "booking", "facebook", "instagram", "privacy", "link"] as const;
export type SignatureLinkKind = (typeof SIGNATURE_LINK_KINDS)[number];

export const SIGNATURE_LINK_KIND_LABELS: Record<SignatureLinkKind, string> = {
  website: "Website",
  whatsapp: "WhatsApp",
  booking: "Booking link",
  facebook: "Facebook",
  instagram: "Instagram",
  privacy: "Privacy policy",
  link: "Other links",
};

/** What a link is, from where it goes — the known ones by their own addresses, the rest by the signature's settings. */
export function signatureLinkKind(url: string, known: { website?: string; bookingUrl?: string | null; privacyUrl?: string }): SignatureLinkKind {
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  if (host === "wa.me" || host.endsWith("whatsapp.com")) return "whatsapp";
  if (host.endsWith("facebook.com") || host === "fb.com") return "facebook";
  if (host.endsWith("instagram.com")) return "instagram";
  const same = (other?: string | null) => Boolean(other) && url.replace(/\/$/, "") === String(other).replace(/\/$/, "");
  if (same(known.bookingUrl)) return "booking";
  if (same(known.privacyUrl)) return "privacy";
  const site = (known.website ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/$/, "").toLowerCase();
  if (site && host && host === site.split("/")[0].replace(/^www\./, "")) return "website";
  return "link";
}

const unescapeAttr = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Every distinct https address linked from this signature HTML (images are not links, and are left alone). */
export function signatureLinkUrls(html: string): string[] {
  return [...new Set([...html.matchAll(/<a\s[^>]*?href="(https:\/\/[^"]+)"/gi)].map((m) => unescapeAttr(m[1])))];
}

/** The signature with each counted link sent through its tracking address. A link with no token is left as it was. */
export function rewriteSignatureLinks(html: string, trackingUrlFor: (url: string) => string | undefined): string {
  return html.replace(/(<a\s[^>]*?href=")(https:\/\/[^"]+)(")/gi, (whole, open: string, href: string, close: string) => {
    const tracked = trackingUrlFor(unescapeAttr(href));
    return tracked ? `${open}${tracked}${close}` : whole;
  });
}

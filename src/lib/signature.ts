/** Email signature: custom HTML if the user set one, else the branded template. */
import { PLATFORM_NAME } from "./platformIdentity";
import type { CompanyProfile } from "./companyBrand";
import { escapeHtml } from "./escapeHtml";

/**
 * Where the signature's static assets (the social glyphs) are served from.
 *
 * This carried a note saying the glyphs were a known white-label gap needing
 * "per-tenant asset hosting, a bigger change than a logo URL". The note was
 * wrong about the fix. There is no hosting problem: every tenant domain is
 * attached to the same deployment, so https://acme-crm.co.za/branding/
 * social-facebook.png already serves the same bytes from the same public/
 * directory. The gap was the BASE URL, and `assetBase` closes it — see
 * lib/tenantOrigin.ts.
 *
 * Kept as a defaulted parameter rather than a lookup because this is a pure
 * string builder, called from a client-rendered settings preview as well as from
 * the send path. An omitted argument is the platform origin, exactly as before.
 */
const SITE = (process.env.NEXT_PUBLIC_APP_URL || "https://crm.denagocpt.co.za").replace(/\/$/, "");


/**
 * `company` is the workspace this signature is FROM — its name, tagline, logo,
 * website and socials. Passed in with the built-in values as the default,
 * because this is a pure string builder called from a client-rendered settings
 * preview as well as from the server; an omitted argument is byte-for-byte the
 * signature that shipped before.
 */
export type SignatureCompany = {
  name: string;
  tagline: string;
  address: string;
  website: string;
  /** The company's main number, beside the individual's mobile. May be empty. */
  switchboard: string;
  /**
   * Origin the social glyphs are fetched from. The tenant's own domain when it
   * has one — the same deployment either way, so this is a change of NAME, not of
   * where the bytes come from. Empty falls back to the platform origin.
   */
  assetBase: string;
  logoUrl: string;
  facebook: string;
  instagram: string;
};

/**
 * `switchboard` is the company's own main number, shown on every signature
 * alongside the individual's mobile. It was typed into the template as a literal
 * — so every tenant's staff, on every email they sent, published Denago's
 * landline and invited their customers to call it. Empty by default now: a
 * number that is not known is a row that is not rendered.
 */
export const DEFAULT_SIGNATURE_COMPANY: SignatureCompany = {
  name: PLATFORM_NAME,
  tagline: "",
  address: "",
  website: "",
  switchboard: "",
  assetBase: "",
  logoUrl: "",
  facebook: "",
  instagram: "",
};

/**
 * The Company Profile as a signature company.
 *
 * Was written out by hand in both callers — the compose action and the settings
 * preview — with the same seven fields in the same order. Two copies of the
 * mapping is how the screen that shows you your signature comes to disagree with
 * the signature that gets sent, which is the one bug this preview exists to
 * prevent.
 *
 * `phone` becomes `switchboard`: the profile's phone is the company's number,
 * and it is what the template used to have hardcoded.
 */
export function signatureCompanyFrom(profile: CompanyProfile, assetBase?: string | null): SignatureCompany {
  return {
    name: profile.name,
    tagline: profile.tagline,
    address: profile.address,
    website: profile.website,
    switchboard: profile.phone,
    assetBase: assetBase ?? "",
    logoUrl: profile.logoUrl || DEFAULT_SIGNATURE_COMPANY.logoUrl,
    facebook: profile.facebook || DEFAULT_SIGNATURE_COMPANY.facebook,
    instagram: profile.instagram || DEFAULT_SIGNATURE_COMPANY.instagram,
  };
}

export function buildSignature(user: {
  name: string;
  email: string;
  mobile?: string | null;
  jobTitle?: string | null;
  signatureHtml?: string | null;
}, company: SignatureCompany = DEFAULT_SIGNATURE_COMPANY): string {
  if (user.signatureHtml?.trim()) return user.signatureHtml;

  const waDigits = (user.mobile ?? "").replace(/\D/g, "").replace(/^0/, "27");
  const safeMobile = user.mobile ? escapeHtml(user.mobile) : null;
  const safeEmail = escapeHtml(user.email);
  const safeName = escapeHtml(user.name);
  const safeJobTitle = user.jobTitle ? escapeHtml(user.jobTitle) : null;
  const assets = company.assetBase.trim().replace(/\/$/, "") || SITE;
  const switchboard = company.switchboard.trim();
  const contactBits = [
    safeMobile
      ? `<a href="tel:${waDigits}" style="color:#475569;text-decoration:none;">${safeMobile}</a>`
      : null,
    // Was a hardcoded "073 789 3438". Rendered only when the workspace has told
    // us its number — an empty row is better than another company's switchboard.
    switchboard
      ? `<a href="tel:${switchboard.replace(/[^\d+]/g, "")}" style="color:#475569;text-decoration:none;">${escapeHtml(switchboard)}</a>`
      : null,
    `<a href="mailto:${encodeURIComponent(user.email)}" style="color:#ea580c;text-decoration:none;">${safeEmail}</a>`,
  ]
    .filter(Boolean)
    .join(`<span style="color:#cbd5e1;">&nbsp;&nbsp;|&nbsp;&nbsp;</span>`);

  const waIcon =
    waDigits.length >= 10
      ? `<a href="https://wa.me/${waDigits}" style="text-decoration:none;"><img src="${assets}/branding/social-whatsapp.png" alt="WhatsApp" width="26" height="26" style="display:block;border:0;" /></a>`
      : "";

  // Every block below is conditional, because the defaults are now EMPTY rather
  // than Denago's. Interpolating a blank into this template does not degrade
  // gracefully: `<img src="">` re-requests the current page and renders as a
  // broken image, `href="https://"` is a dead link, and a footer reading " — "
  // is visible punctuation with nothing either side of it. A field that is not
  // set has to remove its element, not empty it.
  const website = company.website.trim();
  const logoUrl = company.logoUrl.trim();
  const facebook = company.facebook.trim();
  const instagram = company.instagram.trim();
  const websiteHref = `https://${escapeHtml(website)}`;

  const logoImg = `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(company.name)}" width="260" style="display:block;border:0;" />`;
  const logoRow = !logoUrl
    ? ""
    : `  <tr>
    <td style="background-color:#020617;border-radius:10px;padding:12px 18px;">
      ${website ? `<a href="${websiteHref}" style="text-decoration:none;">${logoImg}</a>` : logoImg}
    </td>
  </tr>
`;

  const glyph = (href: string, file: string, alt: string) =>
    `<td style="padding-right:8px;"><a href="${escapeHtml(href)}" style="text-decoration:none;"><img src="${assets}/branding/social-${file}.png" alt="${alt}" width="26" height="26" style="display:block;border:0;" /></a></td>`;

  const socialCells = [
    facebook ? glyph(facebook, "facebook", "Facebook") : "",
    instagram ? glyph(instagram, "instagram", "Instagram") : "",
    waIcon ? `<td style="padding-right:8px;">${waIcon}</td>` : "",
    website
      ? `<td style="vertical-align:middle;"><a href="${websiteHref}" style="color:#ea580c;font-size:13px;font-weight:bold;text-decoration:none;">${escapeHtml(website)}</a></td>`
      : "",
  ].join("");
  const socialRow = !socialCells
    ? ""
    : `  <tr>
    <td style="padding:10px 2px 0;">
      <table cellpadding="0" cellspacing="0" border="0"><tr>
        ${socialCells}
      </tr></table>
    </td>
  </tr>
`;

  // `address` is passed through unescaped by design — it carries entities such
  // as `&amp;` and `·` from the Company Profile — so it is only the join that
  // needs guarding.
  const footerText = [escapeHtml(company.tagline).trim(), company.address.trim()].filter(Boolean).join(" — ");
  const footerRow = !footerText
    ? ""
    : `  <tr>
    <td style="padding-top:8px;color:#94a3b8;font-size:11px;">${footerText}</td>
  </tr>
`;

  return `
<table cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,Helvetica,sans-serif;margin-top:24px;">
${logoRow}  <tr>
    <td style="padding:10px 2px 2px;">
      <span style="font-size:15px;font-weight:bold;color:#0f172a;">${safeName}</span>
      <span style="font-size:12px;color:#94a3b8;">&nbsp;·&nbsp;${safeJobTitle ? `${safeJobTitle}&nbsp;·&nbsp;` : ""}${escapeHtml(company.name)}</span>
    </td>
  </tr>
  <tr>
    <td style="padding:2px 2px;color:#475569;font-size:13px;">${contactBits}</td>
  </tr>
${socialRow}${footerRow}</table>`;
}

/** Wraps editor HTML + signature into a complete email body. */
export function buildEmailHtml(bodyHtml: string, signature: string): string {
  return `<!DOCTYPE html>
<html><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1e293b;line-height:1.6;">
${bodyHtml}
${signature}
</body></html>`;
}

/** Plain-text fallback / timeline version of an HTML email. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Email signature: custom HTML if the user set one, else the branded template. */
import { PLATFORM_NAME } from "./platformIdentity";
import { inlineEmailStyles } from "./emailInlineStyles";
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
  /** The workspace's signature design (Settings → Email → Email signature). Absent = classic. */
  design?: SignatureDesign;
};

/**
 * The workspace's signature design — one for everyone, set by the owner
 * (Sean, 2026-10-07: "I want this signature for everyone… But I also want to be
 * able to change it properly"). Names, job titles and mobiles stay per person
 * (My account); logo, website and phone stay on the Company profile. These are
 * only the parts that belong to the signature itself. Empty lines mean "use the
 * Company profile's", so a profile edit flows through without a second edit here.
 */
export type SignatureDesign = {
  style: "card" | "classic";
  /** Under the name, letterspaced. Empty = the company name. */
  companyLine: string;
  /** Under the rule, beside the pin. Empty = tagline — address. */
  footerLine: string;
};

export const SIGNATURE_DESIGN_KEY = "EMAIL_SIGNATURE";
export const SIGNATURE_LINE_MAX = 160;
/** What every workspace gets until its owner changes it. */
export const DEFAULT_SIGNATURE_DESIGN: SignatureDesign = { style: "card", companyLine: "", footerLine: "" };

/** The stored setting, tolerant of anything: a bad value is the default design, never a broken signature. */
export function parseSignatureDesign(raw: string | null | undefined): SignatureDesign {
  try {
    const v = raw ? JSON.parse(raw) : {};
    const line = (s: unknown) => (typeof s === "string" ? s.trim().slice(0, SIGNATURE_LINE_MAX) : "");
    return {
      style: v?.style === "classic" ? "classic" : "card",
      companyLine: line(v?.companyLine),
      footerLine: line(v?.footerLine),
    };
  } catch {
    return DEFAULT_SIGNATURE_DESIGN;
  }
}

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
export function signatureCompanyFrom(
  profile: CompanyProfile,
  assetBase?: string | null,
  design: SignatureDesign = DEFAULT_SIGNATURE_DESIGN,
): SignatureCompany {
  return {
    design,
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
  if (company.design?.style === "card") return cardSignature(user, company, company.design);

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

/** The card's colours: the Denago logo's own orange (sampled from the PNG) and the logo panel's near-black. */
const CARD_ORANGE = "#f1603c";
const CARD_DARK = "#0b0f19";

/**
 * The "dealer card" signature, from Sean's mock-up: the logo on a dark panel
 * with an orange stripe and a slanted edge, a divider, then the name, the
 * company in letterspaced capitals and the contact line with round icons; a rule
 * and a pinned footer line underneath.
 *
 * Email-client rules, not web rules: tables for layout, every style inline, no
 * CSS shapes — the slant and the icons are PNGs in /branding/signature/
 * (rendered from the Lucide icon paths, so they match the app). The contact
 * items are inline, so on a narrow phone they wrap instead of overflowing.
 * Every part is conditional, like the classic template: an unset field removes
 * its element.
 */
function cardSignature(
  user: { name: string; email: string; mobile?: string | null; jobTitle?: string | null },
  company: SignatureCompany,
  design: SignatureDesign,
): string {
  const assets = `${company.assetBase.trim().replace(/\/$/, "") || SITE}/branding/signature`;
  const website = company.website.trim();
  const websiteHref = `https://${escapeHtml(website.replace(/^https?:\/\//, ""))}`;
  const logoUrl = company.logoUrl.trim();
  // The person's own number first; the company's when they have not set one.
  const phone = (user.mobile ?? "").trim() || company.switchboard.trim();
  const companyLine = (design.companyLine || company.name).trim();
  const titleLine = [user.jobTitle?.trim(), companyLine].filter(Boolean).map((s) => escapeHtml(s!.toUpperCase())).join("&nbsp;&nbsp;·&nbsp;&nbsp;");
  // `address` arrives entity-encoded from the Company Profile (see the classic
  // footer), so the default footer is not escaped a second time; a typed footer is.
  const footer = design.footerLine
    ? escapeHtml(design.footerLine)
    : [escapeHtml(company.tagline).trim(), company.address.trim()].filter(Boolean).join(" — ");

  const icon = (file: string, alt: string) =>
    `<img src="${assets}/${file}.png" alt="${alt}" width="22" height="22" style="vertical-align:middle;border:0;" />`;
  const link = (href: string, text: string, color: string) =>
    `<a href="${href}" style="color:${color};text-decoration:none;">${text}</a>`;
  const contacts = [
    phone ? `${icon("phone", "Phone")}&nbsp;&nbsp;${link(`tel:${phone.replace(/[^\d+]/g, "")}`, escapeHtml(phone), "#0f172a")}` : "",
    `${icon("mail", "Email")}&nbsp;&nbsp;${link(`mailto:${encodeURIComponent(user.email)}`, escapeHtml(user.email), "#0f172a")}`,
    website ? `${icon("web", "Website")}&nbsp;&nbsp;${link(websiteHref, escapeHtml(website), CARD_ORANGE)}` : "",
  ]
    .filter(Boolean)
    .map((item) => `<span style="white-space:nowrap;">${item}</span>`)
    .join(`<span style="color:#cbd5e1;">&nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp;</span>`);

  const logoImg = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(company.name)}" width="170" style="display:block;border:0;" />`
    : "";
  const logoCells = !logoImg
    ? ""
    : // Stripe and divider are BORDERS, not 1–5px cells: a narrow phone squeezes
      // spacer cells to nothing, and a border it can't.
      `<td width="170" height="110" style="width:170px;height:110px;background-color:${CARD_DARK};border-left:5px solid ${CARD_ORANGE};padding:0 4px 0 20px;vertical-align:middle;">${
      website ? `<a href="${websiteHref}" style="text-decoration:none;">${logoImg}</a>` : logoImg
    }</td>
    <td width="30" style="width:30px;padding-right:18px;vertical-align:top;font-size:0;line-height:0;"><img src="${assets}/slant.png" alt="" width="30" height="110" style="display:block;border:0;" /></td>
    `;
  const columns = logoImg ? 3 : 1;
  const divider = logoImg ? "border-left:1px solid #e2e8f0;padding-left:20px;" : "";

  const footerRow = !footer
    ? ""
    : `  <tr>
    <td colspan="${columns}" style="padding-top:14px;">
      <table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%"><tr>
        <td style="border-top:1px solid #e2e8f0;padding-top:10px;font-size:10px;letter-spacing:2px;color:#64748b;text-transform:uppercase;">
          <img src="${assets}/pin.png" alt="" width="14" height="14" style="vertical-align:middle;border:0;" />&nbsp;&nbsp;${footer}
        </td>
      </tr></table>
    </td>
  </tr>
`;

  return `
<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="font-family:Arial,Helvetica,sans-serif;margin-top:24px;border-collapse:collapse;">
  <tr>
    ${logoCells}<td style="${divider}vertical-align:middle;">
      <div style="font-size:22px;font-weight:bold;color:#0f172a;line-height:1.2;">${escapeHtml(user.name)}</div>
      ${titleLine ? `<div style="padding-top:4px;font-size:11px;letter-spacing:3px;color:#64748b;">${titleLine}</div>` : ""}
      <div style="padding-top:12px;font-size:13px;line-height:26px;color:#0f172a;">${contacts}</div>
    </td>
  </tr>
${footerRow}</table>`;
}

/** Wraps editor HTML + signature into a complete email body. */
export function buildEmailHtml(bodyHtml: string, signature: string): string {
  // The body comes out of the SAME rich editor the campaign templates use, so it
  // arrives with the same problem: tags carrying no style attribute, at the mercy
  // of whatever default stylesheet the recipient's client applies. The signature
  // is already inline-styled and is left alone.
  return `<!DOCTYPE html>
<html><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1e293b;line-height:1.6;">
${inlineEmailStyles(bodyHtml)}
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

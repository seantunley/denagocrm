/**
 * The Email signatures pack's extra designs (Sean, 2026-11-20 — item 5 of email-signature-improvements.md): three
 * layouts drawn in the workspace's own colour. Plain HTML and inline styles only — no icon images, so the colour
 * reaches every part (the card's icons are pictures, already orange, which is why the card keeps its own colours).
 * Pure: the signature builder and the settings preview both call it, on the server and in the browser.
 */
import { escapeHtml } from "./escapeHtml";
import { extrasHtml, photoHtml, qualificationsHtml, type SignatureExtras } from "./signaturePeople";
import type { SignatureCompany, SignatureDesign } from "./signature";

export const BRAND_STYLES = ["modern", "compact", "minimal"] as const;
export type BrandStyle = (typeof BRAND_STYLES)[number];

export const BRAND_STYLE_LABELS: Record<BrandStyle, string> = {
  modern: "Modern — a bar in your colour, logo above, labelled contact lines",
  compact: "Compact — logo beside your details, one contact line",
  minimal: "Minimal — text only, no pictures",
};

export const isBrandStyle = (style: unknown): style is BrandStyle => BRAND_STYLES.includes(style as BrandStyle);

/**
 * The design as the pack being OFF uses it: the signature from before the pack. Its extras pause — a pack design falls
 * back to the card; no short replies, privacy link or link counting. Only what is USED changes: the stored design keeps
 * them, so switching the pack back on restores everything (review of #1162).
 */
export function withoutPackExtras(design: SignatureDesign): SignatureDesign {
  return {
    ...design,
    style: isBrandStyle(design.style) ? "card" : design.style,
    shortReplies: false,
    legal: { privacyUrl: "" },
    trackLinks: false,
  };
}

/** The orange every signature used before workspaces had colours; the colour for a workspace that hasn't set one. */
export const DEFAULT_ACCENT = "#ea580c";

/**
 * The workspace's colour (Tenant.brandPrimary), when it is a plain #rrggbb — it goes into a style attribute. Otherwise
 * the design's own colour, so a workspace without one keeps exactly the signature it had.
 */
export function accentOf(company: Pick<SignatureCompany, "accent">, fallback = DEFAULT_ACCENT): string {
  return company.accent && /^#[0-9a-f]{6}$/i.test(company.accent) ? company.accent : fallback;
}

type Person = { name: string; email: string; mobile?: string | null; jobTitle?: string | null; extras?: SignatureExtras; teamLine?: string };

const tel = (number: string) => `tel:${number.replace(/[^\d+]/g, "")}`;
const link = (href: string, text: string, color: string) => `<a href="${escapeHtml(href)}" style="color:${color};text-decoration:none;">${escapeHtml(text)}</a>`;

/** What every design shows, each part empty when unset — an unset field removes its element. */
function partsOf(user: Person, company: SignatureCompany, design: SignatureDesign) {
  const website = company.website.trim().replace(/^https?:\/\//i, "");
  const mobile = (user.mobile ?? "").trim();
  const switchboard = company.switchboard.trim();
  return {
    title: [user.jobTitle?.trim(), (design.companyLine || company.name).trim()].filter(Boolean).map((s) => escapeHtml(s!)).join(" · "),
    mobile,
    // The company's number too, unless it is the same as the person's.
    switchboard: switchboard && switchboard !== mobile ? switchboard : "",
    email: user.email.trim(),
    website,
    logoUrl: company.logoUrl.trim(),
    // `address` arrives entity-encoded from the Company profile, so only a typed footer is escaped (as on the card).
    footer: design.footerLine
      ? escapeHtml(design.footerLine)
      : [escapeHtml(company.tagline).trim(), company.address.trim()].filter(Boolean).join(" — "),
  };
}

export function brandSignature(style: BrandStyle, user: Person, company: SignatureCompany, design: SignatureDesign): string {
  const accent = accentOf(company);
  const p = partsOf(user, company, design);
  const ink = "#334155";
  const name = escapeHtml(user.name);
  const extras = extrasHtml(user.extras, user.teamLine ?? "", accent);
  const footer = p.footer ? `<div style="padding-top:10px;font-size:11px;line-height:16px;color:#94a3b8;">${p.footer}</div>` : "";
  const mail = p.email ? link(`mailto:${encodeURIComponent(p.email)}`, p.email, ink) : "";
  const web = p.website ? link(`https://${p.website}`, p.website, accent) : "";
  const logo = (height: number) =>
    p.logoUrl ? `<img src="${escapeHtml(p.logoUrl)}" alt="${escapeHtml(company.name)}" height="${height}" style="display:block;border:0;height:${height}px;width:auto;" />` : "";

  if (style === "modern") {
    const line = (label: string, value: string) =>
      `<tr><td style="padding:1px 10px 1px 0;font-size:12px;font-weight:bold;color:${accent};">${label}</td><td style="padding:1px 0;font-size:13px;line-height:19px;color:${ink};">${value}</td></tr>`;
    const rows = [
      p.mobile ? line("M", link(tel(p.mobile), p.mobile, ink)) : "",
      p.switchboard ? line("T", link(tel(p.switchboard), p.switchboard, ink)) : "",
      mail ? line("E", mail) : "",
      web ? line("W", web) : "",
    ].join("");
    return `
<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="font-family:Arial,Helvetica,sans-serif;margin-top:24px;">
  <tr><td style="border-left:4px solid ${accent};padding:2px 0 2px 16px;">
    ${p.logoUrl ? `<div style="padding-bottom:12px;">${logo(40)}</div>` : ""}${photoHtml(user.extras, user.name, 56)}<div style="font-size:20px;font-weight:bold;line-height:26px;color:#0f172a;">${name}</div>
    ${p.title ? `<div style="font-size:13px;line-height:18px;color:${accent};">${p.title}</div>` : ""}${qualificationsHtml(user.extras)}
    ${rows ? `<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin-top:8px;">${rows}</table>` : ""}${extras}${footer}
  </td></tr>
</table>`;
  }

  const contactLine = [p.mobile ? link(tel(p.mobile), p.mobile, ink) : "", p.switchboard ? link(tel(p.switchboard), p.switchboard, ink) : "", mail, web]
    .filter(Boolean)
    .join(`<span style="color:#cbd5e1;">&nbsp;&nbsp;|&nbsp;&nbsp;</span>`);
  const details = `${style === "minimal" ? "" : photoHtml(user.extras, user.name, 48)}<div style="font-size:15px;font-weight:bold;line-height:21px;color:${style === "compact" ? accent : "#0f172a"};">${name}</div>
    ${p.title ? `<div style="font-size:12px;line-height:18px;color:#64748b;">${p.title}</div>` : ""}${qualificationsHtml(user.extras)}
    ${contactLine ? `<div style="padding-top:4px;font-size:13px;line-height:19px;color:${ink};">${contactLine}</div>` : ""}${extras}${footer}`;

  if (style === "compact" && p.logoUrl) {
    return `
<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="font-family:Arial,Helvetica,sans-serif;margin-top:24px;">
  <tr>
    <td style="padding-right:16px;vertical-align:middle;">${p.website ? `<a href="${escapeHtml(`https://${p.website}`)}" style="text-decoration:none;">${logo(56)}</a>` : logo(56)}</td>
    <td width="2" style="width:2px;background-color:${accent};font-size:0;line-height:0;">&nbsp;</td>
    <td style="padding-left:16px;vertical-align:middle;">${details}</td>
  </tr>
</table>`;
  }
  // Minimal, and Compact without a logo: the details alone.
  return `
<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="font-family:Arial,Helvetica,sans-serif;margin-top:24px;">
  <tr><td>${details}</td></tr>
</table>`;
}

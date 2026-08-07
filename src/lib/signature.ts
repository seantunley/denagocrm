/** Email signature: custom HTML if the user set one, else the branded template. */

/**
 * Where the signature's static assets (the social glyphs) are served from.
 *
 * Follows NEXT_PUBLIC_APP_URL rather than being hardcoded, so a deployment on a
 * different domain does not embed Denago's in every outgoing signature. The
 * literal stays as the fallback so an unconfigured environment is unchanged.
 *
 * KNOWN WHITE-LABEL GAP: on a per-tenant domain these images are still fetched
 * from the PLATFORM's host, which a recipient can see in the HTML source and in
 * their client's "load remote images" prompt. Hiding it entirely needs per-tenant
 * asset hosting, which is a bigger change than a logo URL. The company's OWN
 * logo already comes from the tenant brand and is not affected.
 */
const SITE = (process.env.NEXT_PUBLIC_APP_URL || "https://crm.denagocpt.co.za").replace(/\/$/, "");

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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
  logoUrl: string;
  facebook: string;
  instagram: string;
};

export const DEFAULT_SIGNATURE_COMPANY: SignatureCompany = {
  name: "Denago Cape Town",
  tagline: "Authorized Denago EV Dealer",
  address: "Cape Town &amp; Winelands · Unit 55, M5 Freeway Business Park, Maitland",
  website: "denagocpt.co.za",
  logoUrl: `${SITE}/branding/denago-logo-email.png`,
  facebook: "https://www.facebook.com/profile.php?id=61585077836921",
  instagram: "https://www.instagram.com/denago_capetown/",
};

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
  const contactBits = [
    safeMobile
      ? `<a href="tel:${waDigits}" style="color:#475569;text-decoration:none;">${safeMobile}</a>`
      : null,
    `<a href="tel:+27737893438" style="color:#475569;text-decoration:none;">073 789 3438</a>`,
    `<a href="mailto:${encodeURIComponent(user.email)}" style="color:#ea580c;text-decoration:none;">${safeEmail}</a>`,
  ]
    .filter(Boolean)
    .join(`<span style="color:#cbd5e1;">&nbsp;&nbsp;|&nbsp;&nbsp;</span>`);

  const waIcon =
    waDigits.length >= 10
      ? `<a href="https://wa.me/${waDigits}" style="text-decoration:none;"><img src="${SITE}/branding/social-whatsapp.png" alt="WhatsApp" width="26" height="26" style="display:block;border:0;" /></a>`
      : "";

  return `
<table cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,Helvetica,sans-serif;margin-top:24px;">
  <tr>
    <td style="background-color:#020617;border-radius:10px;padding:12px 18px;">
      <a href="https://${escapeHtml(company.website)}" style="text-decoration:none;">
        <img src="${escapeHtml(company.logoUrl)}" alt="${escapeHtml(company.name)}" width="260" style="display:block;border:0;" />
      </a>
    </td>
  </tr>
  <tr>
    <td style="padding:10px 2px 2px;">
      <span style="font-size:15px;font-weight:bold;color:#0f172a;">${safeName}</span>
      <span style="font-size:12px;color:#94a3b8;">&nbsp;·&nbsp;${safeJobTitle ? `${safeJobTitle}&nbsp;·&nbsp;` : ""}${escapeHtml(company.name)}</span>
    </td>
  </tr>
  <tr>
    <td style="padding:2px 2px;color:#475569;font-size:13px;">${contactBits}</td>
  </tr>
  <tr>
    <td style="padding:10px 2px 0;">
      <table cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="padding-right:8px;"><a href="${escapeHtml(company.facebook)}" style="text-decoration:none;"><img src="${SITE}/branding/social-facebook.png" alt="Facebook" width="26" height="26" style="display:block;border:0;" /></a></td>
        <td style="padding-right:8px;"><a href="${escapeHtml(company.instagram)}" style="text-decoration:none;"><img src="${SITE}/branding/social-instagram.png" alt="Instagram" width="26" height="26" style="display:block;border:0;" /></a></td>
        ${waIcon ? `<td style="padding-right:8px;">${waIcon}</td>` : ""}
        <td style="vertical-align:middle;"><a href="https://${escapeHtml(company.website)}" style="color:#ea580c;font-size:13px;font-weight:bold;text-decoration:none;">${escapeHtml(company.website)}</a></td>
      </tr></table>
    </td>
  </tr>
  <tr>
    <td style="padding-top:8px;color:#94a3b8;font-size:11px;">${escapeHtml(company.tagline)} — ${company.address}</td>
  </tr>
</table>`;
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

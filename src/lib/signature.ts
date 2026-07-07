/** Email signature: custom HTML if the user set one, else the branded template. */

const SITE = "https://crm.denagocpt.co.za";

export function buildSignature(user: {
  name: string;
  email: string;
  mobile?: string | null;
  signatureHtml?: string | null;
}): string {
  if (user.signatureHtml?.trim()) return user.signatureHtml;

  const waDigits = (user.mobile ?? "").replace(/\D/g, "").replace(/^0/, "27");
  const contactBits = [
    user.mobile
      ? `<a href="tel:${user.mobile.replace(/\s/g, "")}" style="color:#475569;text-decoration:none;">${user.mobile}</a>`
      : null,
    `<a href="tel:+27737893438" style="color:#475569;text-decoration:none;">073 789 3438</a>`,
    `<a href="mailto:${user.email}" style="color:#ea580c;text-decoration:none;">${user.email}</a>`,
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
      <a href="https://denagocpt.co.za" style="text-decoration:none;">
        <img src="${SITE}/branding/denago-logo-email.png" alt="Denago Cape Town EV" width="260" style="display:block;border:0;" />
      </a>
    </td>
  </tr>
  <tr>
    <td style="padding:10px 2px 2px;">
      <span style="font-size:15px;font-weight:bold;color:#0f172a;">${user.name}</span>
      <span style="font-size:12px;color:#94a3b8;">&nbsp;·&nbsp;Denago Cape Town</span>
    </td>
  </tr>
  <tr>
    <td style="padding:2px 2px;color:#475569;font-size:13px;">${contactBits}</td>
  </tr>
  <tr>
    <td style="padding:10px 2px 0;">
      <table cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="padding-right:8px;"><a href="https://www.facebook.com/profile.php?id=61585077836921" style="text-decoration:none;"><img src="${SITE}/branding/social-facebook.png" alt="Facebook" width="26" height="26" style="display:block;border:0;" /></a></td>
        <td style="padding-right:8px;"><a href="https://www.instagram.com/denago_capetown/" style="text-decoration:none;"><img src="${SITE}/branding/social-instagram.png" alt="Instagram" width="26" height="26" style="display:block;border:0;" /></a></td>
        ${waIcon ? `<td style="padding-right:8px;">${waIcon}</td>` : ""}
        <td style="vertical-align:middle;"><a href="https://denagocpt.co.za" style="color:#ea580c;font-size:13px;font-weight:bold;text-decoration:none;">denagocpt.co.za</a></td>
      </tr></table>
    </td>
  </tr>
  <tr>
    <td style="padding-top:8px;color:#94a3b8;font-size:11px;">Authorized Denago EV Dealer — Cape Town &amp; Winelands · Unit 55, M5 Freeway Business Park, Maitland</td>
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

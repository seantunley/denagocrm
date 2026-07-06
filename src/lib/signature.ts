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
  const mobileRow = user.mobile
    ? `<tr><td style="padding:1px 0;color:#475569;font-size:13px;">Mobile: <a href="tel:${user.mobile.replace(/\s/g, "")}" style="color:#475569;text-decoration:none;">${user.mobile}</a></td></tr>`
    : "";
  const waButton =
    waDigits.length >= 10
      ? `<a href="https://wa.me/${waDigits}" style="display:inline-block;background:#25D366;color:#ffffff;font-size:12px;font-weight:bold;text-decoration:none;padding:6px 14px;border-radius:16px;margin-right:8px;">WhatsApp me</a>`
      : "";

  return `
<table cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,Helvetica,sans-serif;margin-top:24px;border-top:2px solid #ea580c;padding-top:12px;">
  <tr>
    <td style="padding-right:16px;vertical-align:top;">
      <img src="${SITE}/branding/denago-mark.png" alt="Denago" width="56" height="56" style="display:block;" />
    </td>
    <td style="vertical-align:top;">
      <table cellpadding="0" cellspacing="0" border="0">
        <tr><td style="font-size:15px;font-weight:bold;color:#0f172a;padding-bottom:1px;">${user.name}</td></tr>
        <tr><td style="font-size:13px;font-weight:bold;color:#ea580c;padding-bottom:6px;">DENAGO CAPE TOWN</td></tr>
        ${mobileRow}
        <tr><td style="padding:1px 0;color:#475569;font-size:13px;">Office: <a href="tel:+27815158319" style="color:#475569;text-decoration:none;">081 515 8319</a></td></tr>
        <tr><td style="padding:1px 0;color:#475569;font-size:13px;"><a href="mailto:${user.email}" style="color:#475569;text-decoration:none;">${user.email}</a></td></tr>
        <tr><td style="padding:1px 0 8px;color:#475569;font-size:13px;">Unit 55, M5 Freeway Business Park, Maitland, Cape Town</td></tr>
        <tr><td>
          ${waButton}<a href="https://denagocpt.co.za" style="display:inline-block;background:#ea580c;color:#ffffff;font-size:12px;font-weight:bold;text-decoration:none;padding:6px 14px;border-radius:16px;">denagocpt.co.za</a>
        </td></tr>
        <tr><td style="padding-top:8px;color:#94a3b8;font-size:11px;">Authorized Denago EV Dealer — Cape Town &amp; Winelands</td></tr>
      </table>
    </td>
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

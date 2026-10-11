/**
 * The legal line: one sentence the owner sets once, put at the foot of EVERY
 * email the CRM sends — a person's own email, a quote, a signing invitation, a
 * reminder (Sean, 2026-10-11, after looking at Mimecast: disclaimers applied by
 * policy to all outbound mail, separate from branding).
 *
 * It exists for the company's registered name and registration number, which
 * the Companies Act (s32) wants on business letters and notices, electronic
 * ones included. It is NOT marketing: it has no switch per customer and no
 * opt-out, and it is kept apart from signature banners for that reason.
 *
 * Empty (the default) adds nothing, so mail is byte-for-byte what it was.
 */
import { escapeHtml } from "./escapeHtml";

export const LEGAL_LINE_KEY = "EMAIL_LEGAL_LINE";
export const LEGAL_LINE_MAX = 400;

/** What the owner typed, as one clean line. */
export function cleanLegalLine(value: string | null | undefined): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, LEGAL_LINE_MAX);
}

/** In the HTML already? The mail sender must never add it twice (a preview adds it too). */
const MARK = "<!--legal-line-->";

/** The line at the very foot of an HTML email: small, grey, centred, under everything else. */
export function htmlWithLegalLine(html: string, line: string): string {
  const text = cleanLegalLine(line);
  if (!text || html.includes(MARK)) return html;
  const block = `${MARK}<div style="margin:18px 0 0;padding:10px 12px 0;border-top:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:16px;color:#64748b;text-align:center;">${escapeHtml(text)}</div>`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${block}</body>`) : `${html}${block}`;
}

/** The same line on the plain-text part, which is what some mail apps and every screen reader show. */
export function textWithLegalLine(text: string, line: string): string {
  const clean = cleanLegalLine(line);
  return !clean || text.includes(clean) ? text : `${text}\n\n${clean}`;
}

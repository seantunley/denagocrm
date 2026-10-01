import { escapeHtml } from "@/lib/escapeHtml";
import { renderTemplate } from "@/lib/template";

/**
 * THE SIGNING EMAILS, AS EDITABLE TEMPLATES.
 *
 * These four messages were hard-coded HTML in dispatch.ts, completionFanout.ts,
 * jobWorker.ts and identity.ts. They are now a subject + plain-text body per
 * kind, editable in Settings → Email templates, rendered into ONE branded,
 * Outlook-safe shell.
 *
 * Pure (no DB, no `server-only`) so tests can drive it directly. The server half
 * — reading the tenant's override and the brand — is `signingEmail.ts`.
 *
 * ── Why the body is plain text, not HTML ────────────────────────────────────
 * The owner edits wording, not markup. Plain text means every character they
 * type is ESCAPED into the HTML, so a template cannot inject markup, a tracking
 * pixel or a lookalike link — and the plain-text alternative falls out of the
 * same source for free.
 *
 * ── The "action" field ──────────────────────────────────────────────────────
 * Each kind that exists to deliver something has one placeholder that cannot be
 * removed: the signing link (invitation, reminder) or the verification code
 * (identity code). A template without it is refused on save, and — in case one
 * reaches the store anyway — the placeholder is appended at send, so the email
 * that goes out always carries what it was sent for. On a line of its own the
 * link renders as the bulletproof button + the paste-this-link line.
 */

// "quote" is not a signing email: it is the "Email quote" message (the quote PDF
// is attached). It shares the editor, the validation and the branded shell, so it
// is one more kind here rather than a second copy of all three.
export type SigningEmailKind = "invite" | "reminder" | "completed" | "otp" | "quote";

export type SigningEmailDef = {
  kind: SigningEmailKind;
  label: string;
  description: string;
  /** AppSetting key the tenant's edited copy is stored under (JSON {subject, body}). */
  settingKey: string;
  subject: string;
  body: string;
  /** Placeholders this kind may use. Anything else is refused on save and blank at send. */
  fields: readonly string[];
  /** The placeholder that can never be removed, or null. */
  action: "signing_link" | "code" | null;
};

const COMMON = [
  "recipient_name",
  "first_name",
  "document_title",
  "quote_number",
  "company_name",
  "sender_name",
  "company_phone",
  "company_email",
] as const;

/** What each placeholder means, for the editor's field list. */
export const SIGNING_FIELD_HELP: Record<string, string> = {
  recipient_name: "Recipient's full name",
  first_name: "Recipient's first name",
  document_title: "Document title, e.g. Quote Q-1026",
  quote_number: "Quote number, e.g. Q-1026 (blank if not a quote)",
  company_name: "Your company name",
  sender_name: "Name of the staff member who sent it",
  company_phone: "Company phone (Settings → Company profile)",
  company_email: "Company email (Settings → Company profile)",
  signing_link: "The personal signing link (required — shown as the button)",
  expiry_date: "Date the signing link expires (blank if none)",
  code: "The 6-digit verification code (required)",
  total: "Quote total incl. VAT, e.g. R 125 000,00",
};

// The defaults are today's wording, so nothing a customer receives changes
// until an owner edits a template.
export const SIGNING_EMAILS: Record<SigningEmailKind, SigningEmailDef> = {
  invite: {
    kind: "invite",
    label: "Signing — invitation",
    description: "Sent when a document is sent for signature.",
    settingKey: "SIGNING_EMAIL_INVITE",
    subject: "Please sign your document: {{document_title}}",
    body: "Hi {{recipient_name}},\n\nPlease review and sign {{document_title}}.\n\n{{signing_link}}\n\nThank you,\n{{company_name}}",
    fields: [...COMMON, "signing_link", "expiry_date"],
    action: "signing_link",
  },
  reminder: {
    kind: "reminder",
    label: "Signing — reminder",
    description: "Sent when a signer is reminded (manually, by the reminder schedule, or the next signer in sequence).",
    settingKey: "SIGNING_EMAIL_REMINDER",
    subject: "Reminder — please sign: {{document_title}}",
    body: "Hi {{recipient_name}},\n\nReminder — please review and sign {{document_title}}.\n\n{{signing_link}}\n\nThank you,\n{{company_name}}",
    fields: [...COMMON, "signing_link", "expiry_date"],
    action: "signing_link",
  },
  completed: {
    kind: "completed",
    label: "Signing — signed copy",
    description: "Sent to every recipient once everyone has signed. The sealed PDF is attached automatically.",
    settingKey: "SIGNING_EMAIL_COMPLETED",
    subject: "Completed & signed: {{document_title}}",
    body: "Hi {{recipient_name}},\n\nEveryone has signed \"{{document_title}}\". The final sealed PDF is attached.\n\n{{company_name}}",
    fields: [...COMMON],
    action: null,
  },
  otp: {
    kind: "otp",
    label: "Signing — verification code",
    description: "Sent when a document requires the signer to confirm their identity by email.",
    settingKey: "SIGNING_EMAIL_OTP",
    subject: "Verification code: {{document_title}}",
    body: "Hi {{recipient_name}},\n\nYour verification code for “{{document_title}}” is:\n\n{{code}}\n\nIt expires in 10 minutes. If you did not ask to sign this document, ignore this message and tell the sender.",
    fields: [...COMMON, "code"],
    action: "code",
  },
  quote: {
    kind: "quote",
    label: "Quote email",
    description: "The starting wording for “Email quote” in the quote editor. Staff see it and can change it before each send; the quote PDF is attached automatically.",
    settingKey: "QUOTE_EMAIL",
    subject: "Your quote {{quote_number}} from {{company_name}}",
    body: "Hi {{first_name}},\n\nThank you for your interest. Your quote {{quote_number}} is attached as a PDF.\n\nIf you have any questions, or would like to go ahead, just reply to this email.\n\nKind regards,\n{{sender_name}}\n{{company_name}}",
    fields: [...COMMON, "total"],
    action: null,
  },
};

export const SIGNING_EMAIL_KINDS = Object.keys(SIGNING_EMAILS) as SigningEmailKind[];

/** Placeholders that carry a secret. They may appear in the body only — never the subject, which lands in previews, logs and timelines. */
const SECRET_FIELDS = new Set(["signing_link", "code"]);

const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;
const MAX_SUBJECT = 200;
const MAX_BODY = 5000;

export type StoredSigningTemplate = { subject: string; body: string };

/** Read a stored override back, defensively. Anything that is not one → null → default. */
export function parseStoredSigningTemplate(raw: string | null | undefined): StoredSigningTemplate | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { subject?: unknown; body?: unknown };
    if (typeof v.subject !== "string" || typeof v.body !== "string") return null;
    if (!v.subject.trim() || !v.body.trim()) return null;
    return { subject: v.subject, body: v.body };
  } catch {
    return null;
  }
}

/** Why this template cannot be saved, or null when it can. */
export function validateSigningTemplate(kind: SigningEmailKind, subject: string, body: string): string | null {
  const def = SIGNING_EMAILS[kind];
  if (!subject.trim() || !body.trim()) return "Subject and body are both required.";
  if (subject.length > MAX_SUBJECT) return `Subject is too long (max ${MAX_SUBJECT} characters).`;
  if (body.length > MAX_BODY) return `Body is too long (max ${MAX_BODY} characters).`;
  const used = (s: string) => [...s.matchAll(PLACEHOLDER)].map((m) => m[1]);
  const unknown = [...new Set([...used(subject), ...used(body)].filter((f) => !def.fields.includes(f)))];
  if (unknown.length) {
    return `Unknown field${unknown.length > 1 ? "s" : ""}: ${unknown.map((f) => `{{${f}}}`).join(", ")}. Use only the fields listed.`;
  }
  const secretInSubject = used(subject).find((f) => SECRET_FIELDS.has(f));
  if (secretInSubject) return `{{${secretInSubject}}} can't go in the subject — put it in the body.`;
  if (def.action && !used(body).includes(def.action)) {
    return `The body must include {{${def.action}}} — without it the recipient has nothing to act on.`;
  }
  // A pasted real signing link would be sent to EVERY recipient: someone else's
  // capability, handed out. The link only ever comes from {{signing_link}}.
  if (/\/signing\/[A-Za-z0-9_-]{8,}/.test(subject + body)) {
    return "Don't paste a signing link into the template — use {{signing_link}}, which is personal to each recipient.";
  }
  return null;
}

export type SigningEmailBrand = {
  companyName: string;
  tagline: string | null;
  /** Absolute, publicly fetchable logo URL, or null for a text wordmark. */
  logoUrl: string | null;
  /** `#rrggbb` accent and readable text on it. */
  accent: string;
  accentText: string;
  phone: string;
  email: string;
};

export const DEFAULT_ACCENT = "#ea580c";

export type RenderedSigningEmail = { subject: string; html: string; text: string };

/**
 * Render one signing email.
 *
 * `vars` is filtered to the kind's own fields, so a caller that passes more
 * (or a template that names more) can never leak anything else into a message.
 */
export function renderSigningEmail(
  kind: SigningEmailKind,
  template: StoredSigningTemplate | null,
  vars: Record<string, string>,
  brand: SigningEmailBrand,
): RenderedSigningEmail {
  const def = SIGNING_EMAILS[kind];
  const tpl = template ?? { subject: def.subject, body: def.body };
  // Null-prototype maps: renderTemplate looks keys up with `vars[key]`, and on a
  // plain object `{{constructor}}` would resolve to Object's own property.
  const allowed: Record<string, string> = Object.create(null);
  for (const f of def.fields) allowed[f] = typeof vars[f] === "string" ? vars[f] : "";

  let body = tpl.body.replace(/\r\n?/g, "\n").trim();
  const action = def.action;
  const hasAction = action ? new RegExp(`\\{\\{\\s*${action}\\s*\\}\\}`).test(body) : true;
  // Never send the email without what it was sent for.
  if (action && !hasAction) body += `\n\n{{${action}}}`;

  // Subject: secrets blanked, whitespace collapsed (no CR/LF reaches a header).
  const subjectVars: Record<string, string> = Object.assign(Object.create(null), allowed);
  for (const f of SECRET_FIELDS) subjectVars[f] = "";
  const subject = renderTemplate(tpl.subject, subjectVars).replace(/\s+/g, " ").trim();

  const actionLine = action ? new RegExp(`^\\{\\{\\s*${action}\\s*\\}\\}$`) : null;
  const paragraphs = body.split(/\n\s*\n/);

  const text = paragraphs
    .map((p) => {
      if (actionLine?.test(p.trim())) {
        return action === "signing_link" ? `Open and sign here:\n${allowed.signing_link}` : allowed.code;
      }
      return renderTemplate(p, allowed);
    })
    .join("\n\n");

  const escaped: Record<string, string> = Object.create(null);
  for (const [k, v] of Object.entries(allowed)) escaped[k] = escapeHtml(v);
  // Inline (mid-sentence) link/code: still clickable/prominent, still escaped.
  if (allowed.signing_link) {
    escaped.signing_link = `<a href="${escapeHtml(allowed.signing_link)}" style="color:${brand.accent};">${escapeHtml(allowed.signing_link)}</a>`;
  }
  if (allowed.code) escaped.code = `<strong>${escapeHtml(allowed.code)}</strong>`;

  const P = `margin:0 0 16px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1e293b;`;
  const content = paragraphs
    .map((p) => {
      if (actionLine?.test(p.trim())) {
        return action === "signing_link"
          ? signButton(allowed.signing_link, brand)
          : `<p style="${P}"><span style="display:inline-block;padding:10px 18px;border:1px solid #e2e8f0;border-radius:8px;font-family:Consolas,Menlo,monospace;font-size:26px;font-weight:bold;letter-spacing:6px;color:#0f172a;">${escapeHtml(allowed.code)}</span></p>`;
      }
      // Escape the TEMPLATE first, then substitute already-escaped values:
      // nothing the owner types or a customer's name contains becomes markup.
      return `<p style="${P}">${renderTemplate(escapeHtml(p), escaped).replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");

  return { subject, html: shell(subject, content, brand), text };
}

/**
 * The bulletproof button.
 *
 * Outlook's Word engine ignores padding on an <a>, which is why the old button
 * rendered as a thin orange strip. The padding and background therefore live
 * on a table cell (honoured everywhere), and Outlook desktop gets a VML
 * roundrect instead, which is the only way to give it a full-size, rounded,
 * clickable button. Followed by the plain link for clients that block both.
 */
export function signButton(url: string, brand: Pick<SigningEmailBrand, "accent" | "accentText">): string {
  const href = escapeHtml(url);
  const font = "font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:bold;";
  return `<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:46px;v-text-anchor:middle;width:200px;" arcsize="17%" stroke="f" fillcolor="${brand.accent}">
<w:anchorlock/><center style="color:${brand.accentText};${font}">Open &amp; sign</center>
</v:roundrect>
<![endif]--><!--[if !mso]><!-->
<table role="presentation" border="0" cellspacing="0" cellpadding="0" style="margin:6px 0 16px;"><tr>
<td align="center" bgcolor="${brand.accent}" style="background-color:${brand.accent};border-radius:8px;padding:13px 26px;">
<a href="${href}" target="_blank" style="${font}color:${brand.accentText};text-decoration:none;display:inline-block;">Open &amp; sign</a>
</td></tr></table>
<!--<![endif]-->
<p style="margin:0 0 16px;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:#64748b;">Or paste this link into your browser:<br><a href="${href}" style="color:#64748b;word-break:break-all;">${href}</a></p>`;
}

function shell(subject: string, content: string, brand: SigningEmailBrand): string {
  const name = escapeHtml(brand.companyName);
  const header = brand.logoUrl
    ? `<img src="${escapeHtml(brand.logoUrl)}" alt="${name}" height="44" style="display:block;border:0;height:44px;width:auto;">`
    : `<div style="font-family:Helvetica,Arial,sans-serif;font-size:16px;font-weight:800;letter-spacing:1px;color:#0f172a;">${escapeHtml(brand.companyName.toUpperCase())}</div>`;
  const footerLines = [
    brand.tagline ? `${name} — ${escapeHtml(brand.tagline)}` : name,
    [brand.phone, brand.email].filter((s) => s.trim()).map(escapeHtml).join(" &middot; "),
  ].filter(Boolean);
  return `<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background-color:#f1f5f9;">
<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="#f1f5f9" style="background-color:#f1f5f9;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="560" border="0" cellspacing="0" cellpadding="0" bgcolor="#ffffff" style="width:100%;max-width:560px;background-color:#ffffff;border-radius:10px;">
<tr><td height="4" bgcolor="${brand.accent}" style="height:4px;line-height:4px;font-size:0;background-color:${brand.accent};border-radius:10px 10px 0 0;">&nbsp;</td></tr>
<tr><td style="padding:24px 28px 8px;">${header}</td></tr>
<tr><td style="padding:12px 28px 8px;">
${content}
</td></tr>
<tr><td style="padding:14px 28px 22px;border-top:1px solid #e2e8f0;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:#94a3b8;">${footerLines.join("<br>")}</td></tr>
</table>
</td></tr></table>
</body>
</html>`;
}

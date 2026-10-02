import { escapeHtml } from "@/lib/escapeHtml";
import { renderTemplate } from "@/lib/template";
import { emailDocToHtml, sanitizeEmailDoc, type EmailDoc } from "./emailDoc";

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

// Despite the name, this is the registry of EVERY system message a customer gets
// from the CRM: the signing emails, "Email quote", and the codes, reminders,
// recalls, review asks and survey invitations. One editor, one validation, one
// branded shell — a kind each, rather than a copy of all three per message.
// SMS kinds (`channel: "sms"`) share the fields and validation, with no subject
// and no shell.
export type SigningEmailKind =
  | "invite"
  | "reminder"
  | "completed"
  | "otp"
  | "quote"
  | "portal_code"
  | "lookup_code"
  | "lookup_code_sms"
  | "service_reminder"
  | "service_reminder_sms"
  | "recall"
  | "recall_sms"
  | "review_delivery"
  | "review_service"
  | "survey_invite"
  | "survey_invite_sms";

/** Placeholders a message can't be sent without. Link ones render as a button when on a line of their own. */
export type ActionField = "signing_link" | "code" | "review_link" | "survey_link";

export type SigningEmailDef = {
  kind: SigningEmailKind;
  label: string;
  description: string;
  /** Section in Settings → Email templates. */
  group: string;
  channel?: "email" | "sms";
  /** AppSetting key the tenant's edited copy is stored under (JSON {subject, body, doc?}). */
  settingKey: string;
  /** Unused for SMS. */
  subject: string;
  body: string;
  /** Placeholders this kind may use. Anything else is refused on save and blank at send. */
  fields: readonly string[];
  /** The placeholder that can never be removed, or null. */
  action: ActionField | null;
};

/** Button text, and the text-part lead-in, for each link action. */
const LINK_ACTIONS: Partial<Record<ActionField, { button: string; lead: string }>> = {
  signing_link: { button: "Open &amp; sign", lead: "Open and sign here:" },
  review_link: { button: "Leave a review", lead: "Leave a review here:" },
  survey_link: { button: "Answer the survey", lead: "Answer here:" },
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
  company_contact: "Company name and phone, e.g. Acme on 021 000 0000",
  model: "Vehicle model, e.g. Rover XL",
  due_date: "Date the service is due",
  recall_title: "Recall title",
  recall_description: "What the recall is about",
  item: "What was delivered or serviced",
  review_link: "Your Google review link (required — shown as a button)",
  survey_link: "The customer's personal survey link (required — shown as a button)",
  survey_intro: "The survey's introduction (set on the survey)",
  survey_title: "Survey title",
  survey_subject: "Suggested subject for this kind of survey",
};

const PERSON = ["first_name", "recipient_name"] as const;
const COMPANY = ["company_name", "company_phone", "company_email", "company_contact"] as const;

// The defaults are today's wording, so nothing a customer receives changes
// until an owner edits a template.
export const SIGNING_EMAILS: Record<SigningEmailKind, SigningEmailDef> = {
  invite: {
    kind: "invite",
    group: "Signing & quotes",
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
    group: "Signing & quotes",
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
    group: "Signing & quotes",
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
    group: "Signing & quotes",
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
    group: "Signing & quotes",
    label: "Quote email",
    description: "The starting wording for “Email quote” in the quote editor. Staff see it and can change it before each send; the quote PDF is attached automatically.",
    settingKey: "QUOTE_EMAIL",
    subject: "Your quote {{quote_number}} from {{company_name}}",
    body: "Hi {{first_name}},\n\nThank you for your interest. Your quote {{quote_number}} is attached as a PDF.\n\nIf you have any questions, or would like to go ahead, just reply to this email.\n\nKind regards,\n{{sender_name}}\n{{company_name}}",
    fields: [...COMMON, "total"],
    action: null,
  },

  portal_code: {
    kind: "portal_code",
    group: "Login & verification codes",
    label: "Customer portal — login code",
    description: "Emailed when a customer signs in to the customer portal.",
    settingKey: "SYSTEM_EMAIL_PORTAL_CODE",
    subject: "Your {{company_name}} portal code",
    body: "Your login code is {{code}}. It expires in 10 minutes.\n\nIf you didn't request this, ignore this email.\n\n{{company_name}}",
    fields: [...PERSON, ...COMPANY, "code"],
    action: "code",
  },
  lookup_code: {
    kind: "lookup_code",
    group: "Login & verification codes",
    label: "Service lookup — code (email)",
    description: "Sent when someone looks up a vehicle by VIN on your website (used when SMS isn't available).",
    settingKey: "SYSTEM_EMAIL_LOOKUP_CODE",
    subject: "Your {{company_name}} verification code",
    body: "Your verification code is {{code}}.\n\nIt expires in 10 minutes. If you didn't request this, you can ignore this email.\n\n{{company_name}}",
    fields: [...PERSON, ...COMPANY, "code"],
    action: "code",
  },
  lookup_code_sms: {
    kind: "lookup_code_sms",
    group: "Login & verification codes",
    channel: "sms",
    label: "Service lookup — code (SMS)",
    description: "Texted when someone looks up a vehicle by VIN on your website.",
    settingKey: "SYSTEM_SMS_LOOKUP_CODE",
    subject: "",
    body: "{{company_name}}: your verification code is {{code}}. It expires in 10 minutes. If you didn't request this, ignore this message.",
    fields: [...PERSON, ...COMPANY, "code"],
    action: "code",
  },

  service_reminder: {
    kind: "service_reminder",
    group: "Service & aftersales",
    label: "Service reminder (email)",
    description: "Sent by the Remind button on Service due. (The nightly automatic reminder uses the template picked under Service reminders.)",
    settingKey: "SYSTEM_EMAIL_SERVICE_REMINDER",
    subject: "Service reminder — your {{model}}",
    body: "Hi {{first_name}},\n\nA quick reminder that your {{model}} is due for a service ({{due_date}}). Reply or call {{company_contact}} and we'll book you in.\n\nWarm regards,\n{{company_name}}",
    fields: [...PERSON, ...COMPANY, "model", "due_date"],
    action: null,
  },
  service_reminder_sms: {
    kind: "service_reminder_sms",
    group: "Service & aftersales",
    channel: "sms",
    label: "Service reminder (SMS)",
    description: "Texted by the Remind button when the customer can't be emailed.",
    settingKey: "SYSTEM_SMS_SERVICE_REMINDER",
    subject: "",
    body: "Hi {{first_name}}, your {{model}} is due for a service ({{due_date}}). Call {{company_contact}} to book. Reply STOP to opt out.",
    fields: [...PERSON, ...COMPANY, "model", "due_date"],
    action: null,
  },
  recall: {
    kind: "recall",
    group: "Service & aftersales",
    label: "Recall notice (email)",
    description: "Sent to every owner of the affected model when you notify a recall.",
    settingKey: "SYSTEM_EMAIL_RECALL",
    subject: "Important: {{recall_title}} — your {{model}}",
    body: "Hi {{first_name}},\n\n{{recall_description}}\n\nPlease contact {{company_contact}} to arrange this at no charge.\n\nWarm regards,\n{{company_name}}",
    fields: [...PERSON, ...COMPANY, "model", "recall_title", "recall_description"],
    action: null,
  },
  recall_sms: {
    kind: "recall_sms",
    group: "Service & aftersales",
    channel: "sms",
    label: "Recall notice (SMS)",
    description: "Texted to owners who can't be emailed.",
    settingKey: "SYSTEM_SMS_RECALL",
    subject: "",
    body: "{{recall_title}}: {{recall_description}} Call {{company_contact}}.",
    fields: [...PERSON, ...COMPANY, "model", "recall_title", "recall_description"],
    action: null,
  },

  review_delivery: {
    kind: "review_delivery",
    group: "Reviews & surveys",
    label: "Google review request — after delivery",
    description: "Sent after a new vehicle is delivered (at most once every 90 days per customer, when a Google Place ID is set).",
    settingKey: "SYSTEM_EMAIL_REVIEW_DELIVERY",
    subject: "Enjoying your new {{item}}? We'd love a quick review ⭐",
    body: "Hi {{first_name}},\n\nCongratulations on your new {{item}} — welcome to the {{company_name}} family! 🎉\n\nIf you're enjoying it, it would mean the world to us if you shared your experience in a quick Google review (it takes under a minute):\n\n{{review_link}}\n\nAnything you need, just call {{company_contact}}.\n\nWarm regards,\n{{company_name}}",
    fields: [...PERSON, ...COMPANY, "item", "review_link"],
    action: "review_link",
  },
  review_service: {
    kind: "review_service",
    group: "Reviews & surveys",
    label: "Google review request — after a service",
    description: "Sent when a job card is completed (at most once every 90 days per customer, when a Google Place ID is set).",
    settingKey: "SYSTEM_EMAIL_REVIEW_SERVICE",
    subject: "How was your service? A quick review would mean a lot ⭐",
    body: "Hi {{first_name}},\n\nThanks for trusting us with {{item}} — we hope everything is running perfectly.\n\nIf you were happy with the service, a quick Google review would mean a lot to our small team (it takes under a minute):\n\n{{review_link}}\n\nAnything not 100%? Rather call {{company_contact}} first and we'll make it right.\n\nWarm regards,\n{{company_name}}",
    fields: [...PERSON, ...COMPANY, "item", "review_link"],
    action: "review_link",
  },
  survey_invite: {
    kind: "survey_invite",
    group: "Reviews & surveys",
    label: "Survey invitation (email)",
    description: "Sent when a survey is triggered for a customer. The introduction is set on each survey.",
    settingKey: "SYSTEM_EMAIL_SURVEY_INVITE",
    subject: "{{survey_subject}}",
    body: "Hi {{first_name}},\n\n{{survey_intro}}\n\nTap below to answer (it takes under a minute):\n\n{{survey_link}}\n\nThank you,\n{{company_name}}",
    fields: [...PERSON, ...COMPANY, "survey_title", "survey_intro", "survey_subject", "survey_link"],
    action: "survey_link",
  },
  survey_invite_sms: {
    kind: "survey_invite_sms",
    group: "Reviews & surveys",
    channel: "sms",
    label: "Survey invitation (SMS)",
    description: "Texted when the customer has no email address.",
    settingKey: "SYSTEM_SMS_SURVEY_INVITE",
    subject: "",
    body: "Hi {{first_name}}, {{survey_intro}} {{survey_link}}",
    fields: [...PERSON, ...COMPANY, "survey_title", "survey_intro", "survey_link"],
    action: "survey_link",
  },
};

export const SIGNING_EMAIL_KINDS = Object.keys(SIGNING_EMAILS) as SigningEmailKind[];

/** Placeholders that carry a secret. They may appear in the body only — never the subject, which lands in previews, logs and timelines. */
const SECRET_FIELDS = new Set(["signing_link", "code", "survey_link"]);

const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;
const MAX_SUBJECT = 200;
const MAX_BODY = 5000;
/** About four SMS segments — long enough for a real message, short enough not to cost a fortune per customer. */
const MAX_SMS = 640;

/**
 * `body` is always the plain text (it drives validation and the text/plain
 * part). `doc` is the formatted version from the editor (emailDoc.ts), when the
 * owner has saved one — kept as `unknown` here and sanitised against the kind's
 * fields every time it is rendered.
 */
export type StoredSigningTemplate = { subject: string; body: string; doc?: unknown };

/** Read a stored override back, defensively. Anything that is not one → null → default. */
export function parseStoredSigningTemplate(raw: string | null | undefined, kind?: SigningEmailKind): StoredSigningTemplate | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { subject?: unknown; body?: unknown; doc?: unknown };
    if (typeof v.subject !== "string" || typeof v.body !== "string") return null;
    // Only an SMS has no subject.
    const sms = kind ? SIGNING_EMAILS[kind].channel === "sms" : false;
    if ((!sms && !v.subject.trim()) || !v.body.trim()) return null;
    return Array.isArray(v.doc) ? { subject: v.subject, body: v.body, doc: v.doc } : { subject: v.subject, body: v.body };
  } catch {
    return null;
  }
}

/** Why this template cannot be saved, or null when it can. */
export function validateSigningTemplate(kind: SigningEmailKind, subject: string, body: string): string | null {
  const def = SIGNING_EMAILS[kind];
  if (def.channel === "sms") {
    if (!body.trim()) return "The message is required.";
    if (body.length > MAX_SMS) return `The text message is too long (max ${MAX_SMS} characters).`;
    subject = "";
  } else {
    if (!subject.trim() || !body.trim()) return "Subject and body are both required.";
    if (subject.length > MAX_SUBJECT) return `Subject is too long (max ${MAX_SUBJECT} characters).`;
    if (body.length > MAX_BODY) return `Body is too long (max ${MAX_BODY} characters).`;
  }
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
  /**
   * Header background. "light" (white, the default) suits a dark logo; a logo
   * drawn in white needs "dark" or "brand" or its lettering disappears.
   */
  header?: EmailHeaderStyle;
};

export type EmailHeaderStyle = "light" | "dark" | "brand";
export const EMAIL_HEADER_STYLES: Record<EmailHeaderStyle, string> = {
  light: "White",
  dark: "Dark",
  brand: "Brand colour",
};
export function parseEmailHeaderStyle(raw: string | null | undefined): EmailHeaderStyle {
  return raw === "dark" || raw === "brand" ? raw : "light";
}

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

  const link = action ? LINK_ACTIONS[action] : undefined;
  const text = paragraphs
    .map((p) => {
      if (action && actionLine?.test(p.trim())) return link ? `${link.lead}\n${allowed[action]}` : allowed[action];
      return renderTemplate(p, allowed);
    })
    .join("\n\n");

  const escaped: Record<string, string> = Object.create(null);
  for (const [k, v] of Object.entries(allowed)) escaped[k] = escapeHtml(v);
  // Inline (mid-sentence) link/code: still clickable/prominent, still escaped.
  for (const f of Object.keys(LINK_ACTIONS)) {
    if (allowed[f]) escaped[f] = `<a href="${escapeHtml(allowed[f])}" style="color:${brand.accent};">${escapeHtml(allowed[f])}</a>`;
  }
  if (allowed.code) escaped.code = `<strong>${escapeHtml(allowed.code)}</strong>`;

  const P = `margin:0 0 16px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1e293b;`;
  const actionHtml = () =>
    action && link
      ? signButton(allowed[action], brand, link.button)
      : `<p style="${P}"><span style="display:inline-block;padding:10px 18px;border:1px solid #e2e8f0;border-radius:8px;font-family:Consolas,Menlo,monospace;font-size:26px;font-weight:bold;letter-spacing:6px;color:#0f172a;">${escapeHtml(allowed.code)}</span></p>`;

  // The formatted body, when the owner saved one; otherwise the plain paragraphs.
  const doc: EmailDoc | null = tpl.doc ? sanitizeEmailDoc(tpl.doc, def.fields) : null;
  if (doc && action && !doc.some((b) => b.children.some((c) => "type" in c && c.type === "mergeField" && c.token === action))) {
    // Never send the email without what it was sent for.
    doc.push({ type: "p", children: [{ type: "mergeField", token: action, children: [{ text: "" }] }] });
  }
  const content = doc
    ? emailDocToHtml(doc, {
        escaped,
        paragraphStyle: P,
        accent: brand.accent,
        actionBlock: action ? (token) => (token === action ? actionHtml() : null) : null,
      })
    : paragraphs
        .map((p) => {
          if (actionLine?.test(p.trim())) return actionHtml();
          // Escape the TEMPLATE first, then substitute already-escaped values:
          // nothing the owner types or a customer's name contains becomes markup.
          return `<p style="${P}">${renderTemplate(escapeHtml(p), escaped).replace(/\n/g, "<br>")}</p>`;
        })
        .join("\n");

  return { subject, html: shell(subject, content, brand), text };
}

/**
 * Render one SMS kind: the template's text with the kind's own fields filled in,
 * the action (code / link) appended if an edited template dropped it, and blank
 * runs collapsed so an empty field doesn't leave a hole.
 */
export function renderSms(kind: SigningEmailKind, template: StoredSigningTemplate | null, vars: Record<string, string>): string {
  const def = SIGNING_EMAILS[kind];
  const allowed: Record<string, string> = Object.create(null);
  for (const f of def.fields) allowed[f] = typeof vars[f] === "string" ? vars[f] : "";
  let body = (template?.body ?? def.body).replace(/\r\n?/g, "\n").trim();
  if (def.action && !new RegExp(`\\{\\{\\s*${def.action}\\s*\\}\\}`).test(body)) body += ` {{${def.action}}}`;
  return renderTemplate(body, allowed).replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
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
export function signButton(
  url: string,
  brand: Pick<SigningEmailBrand, "accent" | "accentText">,
  /** Already-HTML label — only ever one of the LINK_ACTIONS constants. */
  label = "Open &amp; sign",
): string {
  const href = escapeHtml(url);
  const font = "font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:bold;";
  return `<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:46px;v-text-anchor:middle;width:220px;" arcsize="17%" stroke="f" fillcolor="${brand.accent}">
<w:anchorlock/><center style="color:${brand.accentText};${font}">${label}</center>
</v:roundrect>
<![endif]--><!--[if !mso]><!-->
<table role="presentation" border="0" cellspacing="0" cellpadding="0" style="margin:6px 0 16px;"><tr>
<td align="center" bgcolor="${brand.accent}" style="background-color:${brand.accent};border-radius:8px;padding:13px 26px;">
<a href="${href}" target="_blank" style="${font}color:${brand.accentText};text-decoration:none;display:inline-block;">${label}</a>
</td></tr></table>
<!--<![endif]-->
<p style="margin:0 0 16px;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:#64748b;">Or paste this link into your browser:<br><a href="${href}" style="color:#64748b;word-break:break-all;">${href}</a></p>`;
}

function shell(subject: string, content: string, brand: SigningEmailBrand): string {
  const name = escapeHtml(brand.companyName);
  const style = brand.header ?? "light";
  // Light: today's look — accent bar, white header. Dark / brand: the header IS
  // the colour block (no separate bar), and the wordmark turns light.
  const headerBg = style === "dark" ? "#0f172a" : style === "brand" ? brand.accent : null;
  const wordmark = style === "dark" ? "#ffffff" : style === "brand" ? brand.accentText : "#0f172a";
  const header = brand.logoUrl
    ? `<img src="${escapeHtml(brand.logoUrl)}" alt="${name}" height="44" style="display:block;border:0;height:44px;width:auto;">`
    : `<div style="font-family:Helvetica,Arial,sans-serif;font-size:16px;font-weight:800;letter-spacing:1px;color:${wordmark};">${escapeHtml(brand.companyName.toUpperCase())}</div>`;
  const headerRows = headerBg
    ? `<tr><td bgcolor="${headerBg}" style="padding:22px 28px;background-color:${headerBg};border-radius:10px 10px 0 0;">${header}</td></tr>
<tr><td style="height:12px;line-height:12px;font-size:0;">&nbsp;</td></tr>`
    : `<tr><td height="4" bgcolor="${brand.accent}" style="height:4px;line-height:4px;font-size:0;background-color:${brand.accent};border-radius:10px 10px 0 0;">&nbsp;</td></tr>
<tr><td style="padding:24px 28px 8px;">${header}</td></tr>`;
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
${headerRows}
<tr><td style="padding:12px 28px 8px;">
${content}
</td></tr>
<tr><td style="padding:14px 28px 22px;border-top:1px solid #e2e8f0;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:#94a3b8;">${footerLines.join("<br>")}</td></tr>
</table>
</td></tr></table>
</body>
</html>`;
}

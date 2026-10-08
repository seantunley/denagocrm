/**
 * The starting point of every customer email in the editor (Sean chose design
 * B, 2026-10-08): the shared FRAME — the logo panel at the top, the message,
 * the signature, a quiet footer — and each message's BODY, converted from the
 * wording the workspace already sends (its own edited copy when it has one),
 * so moving to the editor changes the look, not what customers are told.
 *
 * Pure and DETERMINISTIC (ids derive from position) — the same input always
 * builds the same document.
 */
import { documentSchema, type DocumentBlock, type DocumentModel } from "./model";
import { LINK_FIELDS } from "./emailRender";
import {
  SIGNING_EMAILS,
  SIGNING_EMAIL_KINDS,
  isTextTemplate,
  type SigningEmailKind,
  type StoredSigningTemplate,
} from "../signing/emailTemplates";
import { sanitizeEmailDoc } from "../signing/emailDoc";
import { REPLACED_STANDARD_WORDINGS, type EmailWording } from "./emailWordingHistory";

export const EMAIL_FRAME_KEY = "email:frame";
export const emailBodyKey = (kind: SigningEmailKind) => `email:${kind}`;
export function emailKindOf(key: string): SigningEmailKind | null {
  const kind = key.startsWith("email:") ? key.slice("email:".length) : "";
  return (SIGNING_EMAIL_KINDS as string[]).includes(kind) && !isTextTemplate(SIGNING_EMAILS[kind as SigningEmailKind])
    ? (kind as SigningEmailKind)
    : null;
}
/** The email kinds (texts and WhatsApp messages stay text). */
export const EMAIL_KINDS = SIGNING_EMAIL_KINDS.filter((k) => !isTextTemplate(SIGNING_EMAILS[k]));

type Plate = Record<string, unknown>;
const TOKEN = /\{\{\s*([\w.]+)\s*\}\}/g;
const layout = { settings: {}, locked: false, hidden: false } as const;

/**
 * Sample details for previews — obviously made up, so a preview can never be
 * mistaken for a real send. Every message field has one.
 */
export const EMAIL_SAMPLE_FIELDS: Record<string, string> = {
  recipient_name: "Jane Doe", first_name: "Jane", document_title: "Quote Q-1026", quote_number: "Q-1026",
  company_name: "", sender_name: "", sender_title: "", sender_mobile: "", sender_email: "", company_phone: "", company_email: "", company_contact: "",
  signing_link: "https://example.com/signing/preview-only", expiry_date: "14 Oct 2026", code: "482913",
  total: "R 125 000,00", model: "Rover XL", item: "Rover XL", due_date: "14 Oct 2026",
  recall_title: "Brake cable inspection", recall_description: "We're checking the rear brake cable on all Rover XL vehicles built before June 2026.",
  review_link: "https://example.com/review/preview-only", survey_title: "Service feedback",
  survey_intro: "We'd love to hear how your service went.", survey_subject: "How was your service?",
  survey_link: "https://example.com/survey/preview-only",
};

/** A headline for each email, using only that message's own fields. */
export const EMAIL_HEADLINES: Partial<Record<SigningEmailKind, string>> = {
  invite: "{{document_title}} is ready for your signature",
  reminder: "{{document_title}} is awaiting your signature",
  completed: "Signed and complete",
  otp: "Your verification code",
  quote: "Your quotation {{quote_number}}",
  portal_code: "Your login code",
  lookup_code: "Your verification code",
  service_reminder: "Your {{model}} is due for a service",
  recall: "{{recall_title}}",
  review_delivery: "How are you enjoying your new {{item}}?",
  review_service: "How was your recent service?",
  survey_invite: "{{survey_title}}",
  survey_reminder: "{{survey_title}}",
};

/** Text → Plate leaves, every {{token}} an inline merge-field node. */
function leaves(text: string, marks: Plate = {}): Plate[] {
  const out: Plate[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const at = match.index ?? 0;
    if (at > last) out.push({ ...marks, text: text.slice(last, at) });
    out.push({ type: "mergeField", token: match[1], children: [{ text: "" }] });
    last = at + match[0].length;
  }
  if (last < text.length) out.push({ ...marks, text: text.slice(last) });
  return out.length ? out : [{ text: "" }];
}

function frameRow(id: string, block: DocumentBlock) {
  return { id: `${id}-row`, columns: [{ id: `${id}-col`, widthPercent: 100, blocks: [block] }], settings: { gap: 16, keepTogether: false, keepWithNext: false } };
}

function emailDocument(title: string, blocks: DocumentBlock[], subject?: string): DocumentModel {
  return documentSchema.parse({
    schemaVersion: 1,
    title,
    style: { fontFamily: "sans", pageSize: "Email", margin: 32, accent: "#f1603c", ink: "#0b1220" },
    recipients: [],
    pages: [{ id: "email-page", rows: blocks.map((b) => frameRow(b.id, b)) }],
    ...(subject !== undefined ? { email: { subject } } : {}),
  });
}

/** What a new header, signature and footer start as (the model's own defaults, spelled out for literals). */
export const EMAIL_HEADER_DEFAULTS = { style: "panel", background: "#0b0f19", logoWidth: 210, align: "left" } as const;
export const EMAIL_SIGNATURE_DEFAULTS = { showJobTitle: true, showCompany: true, showPhone: true, showEmail: true, showWebsite: true } as const;
export const EMAIL_FOOTER_DEFAULTS = { note: "", showCompany: true, showContact: true, align: "center", color: "#94a3b8", background: "" } as const;

/** Design B: the logo panel, the message, the signature, a quiet footer. */
export function defaultEmailFrame(): DocumentModel {
  return emailDocument("Email frame — header, signature and footer", [
    { id: "frame-header", type: "emailHeader", ...layout, ...EMAIL_HEADER_DEFAULTS },
    { id: "frame-body", type: "emailBody", ...layout },
    { id: "frame-signature", type: "emailSignature", ...layout, ...EMAIL_SIGNATURE_DEFAULTS },
    { id: "frame-footer", type: "emailFooter", ...layout, ...EMAIL_FOOTER_DEFAULTS },
  ]);
}

/**
 * One message's body from its current wording. Paragraphs become text; the
 * line holding only the message's link or code becomes its button (or code
 * box), where it stood; a quote email also shows its number and total.
 */
export function defaultEmailBody(
  kind: SigningEmailKind,
  stored?: StoredSigningTemplate | null,
  /** The standard wording to build from — today's, unless rebuilding what an older revision seeded (isUntouchedEmailSeed). */
  wording: EmailWording = { subject: SIGNING_EMAILS[kind].subject, body: SIGNING_EMAILS[kind].body, headline: EMAIL_HEADLINES[kind] ?? "" },
): DocumentModel {
  const def = SIGNING_EMAILS[kind];
  const action = def.action ?? null;
  const blocks: DocumentBlock[] = [];
  let n = 0;
  const id = (what: string) => `${kind}-${what}-${n++}`;
  const headline = wording.headline;
  if (headline) blocks.push({ id: id("heading"), type: "heading", ...layout, value: [{ type: "h2", children: leaves(headline) }] });

  let flow: Plate[] = [];
  const flush = () => {
    if (flow.length) blocks.push({ id: id("text"), type: "text", ...layout, value: flow });
    flow = [];
  };
  const button = () => {
    flush();
    blocks.push({ id: id("button"), type: "emailButton", ...layout, token: action!, label: LINK_FIELDS[action!]?.label ?? "Open", style: "dark" });
  };

  // The owner's formatted copy when there is one (sanitised to this message's
  // own fields, as the send path does), else the plain wording.
  const doc = stored?.doc ? sanitizeEmailDoc(stored.doc, def.fields) : null;
  if (doc?.length) {
    for (const b of doc) {
      const only = b.children.length === 1 && "type" in b.children[0] && b.children[0].type === "mergeField" ? b.children[0].token : null;
      if (action && only === action) { button(); continue; }
      const node: Plate = { type: b.type, ...(b.align ? { align: b.align } : {}), children: b.children };
      if (b.listStyleType) {
        const list = b.listStyleType === "decimal" ? "ol" : "ul";
        const last = flow[flow.length - 1];
        const item = { type: "li", children: b.children };
        if (last?.type === list) (last.children as Plate[]).push(item);
        else flow.push({ type: list, children: [item] });
      } else flow.push(node);
    }
  } else {
    const body = (stored?.body ?? wording.body).replace(/\r\n?/g, "\n").trim();
    const actionLine = action ? new RegExp(`^\\{\\{\\s*${action}\\s*\\}\\}$`) : null;
    for (const paragraph of body.split(/\n\s*\n/)) {
      if (actionLine?.test(paragraph.trim())) { button(); continue; }
      // Line breaks inside a paragraph: one Plate paragraph per line keeps them.
      for (const line of paragraph.split("\n")) flow.push({ type: "p", children: leaves(line) });
    }
  }
  // The sign-off's name lines ("{{sender_name}}", "{{company_name}}") go: the
  // frame's signature now says who it is from, and twice reads as a mistake.
  while (flow.length && isNameLine(flow[flow.length - 1])) flow.pop();
  flush();

  if (kind === "quote") {
    // The quote's number and total, the two figures a customer looks for: after
    // the greeting and the main paragraph, before the closing lines.
    const facts: DocumentBlock = {
      id: id("facts"), type: "emailFacts", ...layout,
      items: [
        { label: "QUOTE", value: "{{quote_number}}", sub: "", highlight: false },
        { label: "TOTAL INCL. VAT", value: "{{total}}", sub: "", highlight: true },
      ],
    };
    const at = blocks.findIndex((b) => b.type === "text");
    const text = blocks[at];
    if (text?.type === "text" && text.value.length > 2) {
      const rest: DocumentBlock = { ...text, id: `${text.id}-rest`, value: text.value.slice(2) };
      blocks.splice(at, 1, { ...text, value: text.value.slice(0, 2) }, facts, rest);
    } else blocks.splice(at < 0 ? blocks.length : at + 1, 0, facts);
  }
  return emailDocument(def.label, blocks, stored?.subject ?? wording.subject);
}

/** Key order and absent-vs-undefined never make two documents differ (Postgres jsonb reorders keys). */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/**
 * Is this stored draft EXACTLY what seeding produced from a standard wording
 * that has since been replaced — i.e. nobody has changed a character of it?
 *
 * Decided by content alone. Any edit, however early (the editor autosaves
 * about a second after a keystroke) or small, makes the draft differ from
 * every seed, so it is never taken for untouched. Both sides go through the
 * schema first, so fields added to the model since are not a difference.
 */
export function isUntouchedEmailSeed(kind: SigningEmailKind, data: unknown, stored?: StoredSigningTemplate | null): boolean {
  const draft = documentSchema.safeParse(data);
  if (!draft.success) return false;
  const now = canonical(draft.data);
  return REPLACED_STANDARD_WORDINGS.some((revision) => {
    const wording = revision[kind];
    return !!wording && canonical(defaultEmailBody(kind, stored, wording)) === now;
  });
}

/** A paragraph holding only the sender's or company's name field. */
function isNameLine(node: Plate): boolean {
  const children = (node.children as Plate[] | undefined) ?? [];
  const real = children.filter((c) => !(typeof c.text === "string" && !c.text.trim()));
  return node.type === "p" && real.length === 1 && real[0].type === "mergeField" && ["sender_name", "company_name"].includes(String(real[0].token));
}

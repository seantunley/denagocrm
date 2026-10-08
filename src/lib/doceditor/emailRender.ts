/**
 * A customer email from two documents of the editor: the shared FRAME (header,
 * signature, footer around an `emailBody` slot) and one message's BODY.
 *
 * Email-client rules, not web rules: tables for layout, every style inline, a
 * 600px card that stacks on phones (a media query the major apps honour), the
 * button drawn twice (VML for Outlook, a padded cell for everyone else).
 * Images are referenced by address; sendEmail embeds the workspace's own
 * (emailInlineLogo.ts).
 *
 * Pure — no server imports — so the editor's canvas can draw the same blocks.
 * Every value from a record is escaped; a field the message does not have
 * renders as nothing, never as a placeholder a customer could see.
 */
import type { DocumentBlock, DocumentModel, DocumentRow } from "./model";
import { cssColor } from "./css";
import { buildSignature, signatureCompanyFrom, CARD_DARK, CARD_ORANGE } from "../signature";

export const EMAIL_FONT = "'Montserrat','Segoe UI',Helvetica,Arial,sans-serif";
const INK = "#0b1220";
const BODY = "#334155";
const MUTED = "#64748b";
const QUIET = "#94a3b8";
const LINE = "#e6eaf0";

/** The message fields that are links: shown as a button, and as a link wherever they are typed inline. */
export const LINK_FIELDS: Record<string, { label: string; lead: string }> = {
  signing_link: { label: "Open & sign", lead: "Open and sign here:" },
  review_link: { label: "Leave a review", lead: "Leave a review here:" },
  survey_link: { label: "Answer the survey", lead: "Answer here:" },
};
/** Never in a subject line: a subject is shown in notification previews and inbox lists. */
const SECRET_FIELDS = new Set(["signing_link", "code", "survey_link"]);

export type EmailBrand = {
  companyName: string;
  tagline: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  /** Public https (or data:) address of the logo. */
  logoUrl: string;
  /** The signature's logo-panel banner — preferred for the header when set. */
  bannerUrl: string;
  accent: string;
  /** Where the signature's icons are served from (the workspace's own origin). */
  assetBase: string;
};

export type EmailRenderInput = {
  frame: DocumentModel;
  body: DocumentModel;
  /** The message's own fields (recipient_name, signing_link …) and company_* — raw values. */
  fields: Record<string, string>;
  brand: EmailBrand;
  /** The field the message exists to deliver; added as a button/code if the body dropped it. */
  action?: string | null;
};

export type RenderedEmail = { subject: string; html: string; text: string };

const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** A link a customer may be sent to: http(s) or mailto, nothing else. */
function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (/^mailto:[^\s<>"]+$/i.test(url)) return url;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Every {{token}} a message can use: its own fields, plus company.* spelled the editor's way. */
function tokenMap(fields: Record<string, string>, brand: EmailBrand): Record<string, string> {
  const map: Record<string, string> = Object.create(null);
  for (const [k, v] of Object.entries(fields)) map[k] = typeof v === "string" ? v : "";
  const company: Record<string, string> = {
    name: brand.companyName, tagline: brand.tagline, address: brand.address,
    phone: brand.phone, email: brand.email, website: brand.website,
  };
  for (const [k, v] of Object.entries(company)) {
    map[`company.${k}`] = v;
    map[`company_${k}`] ??= v;
  }
  return map;
}

const fill = (s: string, tokens: Record<string, string>) =>
  (s ?? "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k: string) => tokens[k] ?? "");

// ── rich text (the editor's Plate value) → inline-styled email HTML ───────
type Node = { text?: string; bold?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean;
  type?: string; token?: string; url?: string; align?: string; listStyleType?: string; children?: Node[] };

const TEXT = `font-size:15px;line-height:1.7;color:${BODY};`;
const HEADINGS: Record<string, string> = {
  h1: `margin:0 0 14px;font-size:30px;line-height:1.2;font-weight:800;color:${INK};letter-spacing:-0.3px;`,
  h2: `margin:0 0 14px;font-size:28px;line-height:1.2;font-weight:800;color:${INK};letter-spacing:-0.3px;`,
  h3: `margin:0 0 10px;font-size:19px;line-height:1.3;font-weight:700;color:${INK};`,
};

function inlineHtml(node: Node, tokens: Record<string, string>, accent: string): string {
  if (typeof node.text === "string") {
    let t = esc(fill(node.text, tokens));
    if (!t) return "";
    if (node.bold) t = `<strong>${t}</strong>`;
    if (node.italic) t = `<em>${t}</em>`;
    if (node.underline) t = `<u>${t}</u>`;
    if (node.strikethrough) t = `<s>${t}</s>`;
    return t;
  }
  if (node.type === "mergeField" && node.token) {
    const value = tokens[node.token] ?? "";
    if (!value) return "";
    // A link field typed mid-sentence stays a working link; a code stands out.
    if (LINK_FIELDS[node.token]) {
      const href = safeHref(value);
      return href ? `<a href="${esc(href)}" style="color:${accent};">${esc(value)}</a>` : esc(value);
    }
    return node.token === "code" ? `<strong>${esc(value)}</strong>` : esc(value);
  }
  if (node.type === "a") {
    const href = node.url ? safeHref(node.url) : null;
    const inner = (node.children ?? []).map((c) => inlineHtml(c, tokens, accent)).join("");
    return href ? `<a href="${esc(href)}" style="color:${accent};">${inner}</a>` : inner;
  }
  return (node.children ?? []).map((c) => inlineHtml(c, tokens, accent)).join("");
}

function richTextHtml(value: unknown, tokens: Record<string, string>, accent: string, textAlign?: string): string {
  const align = (n: Node) => {
    const a = n.align ?? textAlign;
    return a === "center" || a === "centre" ? "text-align:center;" : a === "right" ? "text-align:right;" : "";
  };
  const block = (n: Node): string => {
    const inner = (n.children ?? []).map((c) => inlineHtml(c, tokens, accent)).join("");
    switch (n.type) {
      case "h1": case "h2": case "h3":
        return `<div style="${HEADINGS[n.type]}${align(n)}">${inner}</div>`;
      case "blockquote":
        return `<div style="margin:0 0 14px;padding-left:14px;border-left:3px solid ${LINE};${TEXT}color:#475569;${align(n)}">${inner}</div>`;
      case "ul": case "ol":
        return `<${n.type} style="margin:0 0 14px;padding-left:22px;">${(n.children ?? []).map(block).join("")}</${n.type}>`;
      case "li":
        return `<li style="margin:0 0 6px;${TEXT}">${inner}</li>`;
      default:
        return `<p style="margin:0 0 14px;${TEXT}${align(n)}">${inner || "&nbsp;"}</p>`;
    }
  };
  return (Array.isArray(value) ? (value as Node[]) : []).map(block).join("");
}

function richTextPlain(value: unknown, tokens: Record<string, string>): string {
  const inline = (n: Node): string =>
    typeof n.text === "string" ? fill(n.text, tokens)
      : n.type === "mergeField" && n.token ? tokens[n.token] ?? ""
        : (n.children ?? []).map(inline).join("");
  const block = (n: Node): string =>
    n.type === "ul" || n.type === "ol" ? (n.children ?? []).map((li) => `• ${inline(li)}`).join("\n") : inline(n);
  return (Array.isArray(value) ? (value as Node[]) : []).map(block).filter((s) => s.trim()).join("\n\n");
}

// ── the email blocks ─────────────────────────────────────────────────────
/** The bulletproof button: VML for Outlook's Word engine, a padded cell for everyone else. */
function buttonHtml(href: string, label: string, bg: string, accent: string): string {
  const font = `font-family:${EMAIL_FONT};font-size:15px;font-weight:700;`;
  return `<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${esc(href)}" style="height:48px;v-text-anchor:middle;width:240px;" arcsize="20%" stroke="f" fillcolor="${bg}">
<w:anchorlock/><center style="color:#ffffff;${font}">${esc(label)}</center>
</v:roundrect>
<![endif]--><!--[if !mso]><!-->
<table role="presentation" border="0" cellspacing="0" cellpadding="0" style="margin:8px 0 18px;"><tr>
<td bgcolor="${bg}" style="background-color:${bg};border-radius:10px;padding:15px 30px;">
<a href="${esc(href)}" target="_blank" style="${font}color:#ffffff;text-decoration:none;display:inline-block;">${esc(label)}&nbsp;&nbsp;<span style="color:${bg === accent ? "#ffffff" : accent};">&rarr;</span></a>
</td></tr></table>
<!--<![endif]-->`;
}

function factsHtml(items: { label: string; value: string; sub: string; highlight: boolean }[], tokens: Record<string, string>, accent: string): string {
  const shown = items.filter((i) => fill(i.value, tokens).trim() || fill(i.label, tokens).trim());
  if (!shown.length) return "";
  const width = Math.floor(100 / shown.length);
  const cells = shown.map((item, i) => {
    const dark = item.highlight;
    const pad = shown.length === 1 ? "" : i === 0 ? "padding-right:8px;" : i === shown.length - 1 ? "padding-left:8px;" : "padding:0 4px;";
    return `<td class="fact" width="${width}%" style="${pad}vertical-align:top;">
      <div style="${dark ? `background:${CARD_DARK};` : `border:1px solid ${LINE};`}border-radius:12px;padding:16px 18px;">
        <div style="font-size:11px;letter-spacing:2.5px;color:${dark ? QUIET : MUTED};">${esc(fill(item.label, tokens))}</div>
        <div style="padding-top:6px;font-size:22px;font-weight:800;color:${dark ? accent : INK};">${esc(fill(item.value, tokens))}</div>
        ${item.sub ? `<div style="padding-top:2px;font-size:13px;color:${dark ? QUIET : MUTED};">${esc(fill(item.sub, tokens))}</div>` : ""}
      </div>
    </td>`;
  });
  return `<table role="presentation" class="facts" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px;"><tr>${cells.join("")}</tr></table>`;
}

function codeHtml(code: string): string {
  return `<div style="margin:8px 0 18px;"><span style="display:inline-block;padding:12px 22px;border:1px solid ${LINE};border-radius:10px;font-family:Consolas,Menlo,monospace;font-size:28px;font-weight:bold;letter-spacing:8px;color:${INK};">${esc(code)}</span></div>`;
}

type Ctx = { tokens: Record<string, string>; brand: EmailBrand; accent: string };

/** One block of a message (or of the frame, outside the slots). */
export function emailBlockHtml(block: DocumentBlock, ctx: Ctx): string {
  if (block.hidden) return "";
  const { tokens, accent } = ctx;
  switch (block.type) {
    case "heading":
    case "text":
      return richTextHtml(block.value, tokens, accent, block.settings?.textAlign);
    case "image": {
      const raw = fill(String(block.src || ""), tokens).trim();
      if (!/^(https:|data:image\/)/i.test(raw)) return "";
      const width = Math.max(5, Math.min(100, block.widthPct));
      return `<div style="margin:4px 0 16px;"><img src="${esc(raw)}" alt="${esc(block.alt)}" width="${Math.round(5.2 * width)}" style="display:block;width:${width}%;max-width:100%;height:auto;border:0;${block.rounded ? "border-radius:12px;" : ""}" /></div>`;
    }
    case "divider":
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:10px 0 18px;"><tr><td style="border-top:${Math.max(1, Math.min(6, block.thickness))}px solid ${cssColor(block.color, LINE)};font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
    case "spacer":
      return `<div style="height:${Math.max(0, Math.min(200, block.height))}px;line-height:0;font-size:0;">&nbsp;</div>`;
    case "emailButton": {
      const value = tokens[block.token] ?? "";
      if (block.token === "code") return value ? codeHtml(value) : "";
      const href = safeHref(value) ?? "#";
      const label = fill(block.label, tokens) || LINK_FIELDS[block.token]?.label || "Open";
      const bg = block.style === "accent" ? accent : CARD_DARK;
      const fallback = href !== "#" && SECRET_FIELDS.has(block.token)
        ? `<p style="margin:0 0 16px;font-size:12px;line-height:1.5;color:${MUTED};">Or paste this link into your browser:<br><a href="${esc(href)}" style="color:${MUTED};word-break:break-all;">${esc(href)}</a></p>`
        : "";
      return buttonHtml(href, label, bg, accent) + fallback;
    }
    case "emailFacts":
      return factsHtml(block.items, tokens, accent);
    case "emailSignature":
      return signatureHtml(ctx);
    case "emailFooter":
      return footerHtml(block.note, ctx);
    case "emailHeader":
      return headerHtml(ctx.brand);
    default:
      // Print-only blocks (line items, totals bands, showcase) have no email form.
      return "";
  }
}

function headerHtml(brand: EmailBrand): string {
  const name = esc(brand.companyName);
  if (brand.bannerUrl) {
    return `<img class="sig-banner" src="${esc(brand.bannerUrl)}" alt="${name}" width="400" style="display:block;border:0;width:400px;max-width:80%;height:auto;" />`;
  }
  if (brand.logoUrl) {
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td width="240" height="110" style="width:240px;height:110px;background-color:${CARD_DARK};padding:0 6px 0 28px;vertical-align:middle;"><img src="${esc(brand.logoUrl)}" alt="${name}" width="210" style="display:block;border:0;" /></td>
      <td width="37" style="width:37px;vertical-align:top;font-size:0;line-height:0;"><img src="${esc(assetBase(brand))}/slant.png" alt="" width="37" height="110" style="display:block;border:0;" /></td>
    </tr></table>`;
  }
  return `<div style="display:inline-block;background:${CARD_DARK};padding:22px 28px;font-size:18px;font-weight:800;letter-spacing:2px;color:#ffffff;">${esc(brand.companyName.toUpperCase())}</div>`;
}

const assetBase = (brand: EmailBrand) => `${brand.assetBase.replace(/\/$/, "")}/branding/signature`;

/**
 * Inside the branded frame the header already carries the logo and the footer
 * the address, so the signature is the person: the sender's name (the company's
 * for automatic messages), the company, and its phone / email / website.
 */
function signatureHtml(ctx: Ctx): string {
  const { brand, tokens } = ctx;
  const name = tokens.sender_name?.trim() || brand.companyName;
  return buildSignature(
    { name, email: brand.email, mobile: null, jobTitle: null },
    signatureCompanyFrom(
      { name: brand.companyName, tagline: "", address: "", phone: brand.phone, email: brand.email, website: brand.website, facebook: "", instagram: "", logoUrl: "" },
      brand.assetBase,
    ),
  );
}

function footerHtml(note: string, ctx: Ctx): string {
  const { brand, tokens } = ctx;
  const lines = [
    fill(note, tokens).trim(),
    [brand.companyName, brand.address].filter((s) => s.trim()).join(" · "),
    [brand.phone, brand.email, brand.website].filter((s) => s.trim()).join("  ·  "),
  ].filter(Boolean);
  return lines.map(esc).join("<br />");
}

// ── assembling the email ─────────────────────────────────────────────────
const blocksOf = (rows: DocumentRow[]) => rows.flatMap((row) => row.columns.flatMap((col) => col.blocks));

/** A row of a message: its blocks, or — with two or more columns — cells that stack on phones. */
function rowHtml(row: DocumentRow, ctx: Ctx): string {
  const cols = row.columns.filter((c) => c.blocks.some((b) => !b.hidden));
  if (!cols.length) return "";
  if (cols.length === 1) return cols[0].blocks.map((b) => emailBlockHtml(b, ctx)).join("");
  const gap = row.settings?.gap ?? 16;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${cols
    .map((c, i) => `<td class="col" width="${Math.round(c.widthPercent)}%" style="vertical-align:top;${i ? `padding-left:${gap}px;` : ""}">${c.blocks.map((b) => emailBlockHtml(b, ctx)).join("")}</td>`)
    .join("")}</tr></table>`;
}

const HEAD = (subject: string) => `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title>${esc(subject)}</title>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@500;600;700;800&amp;display=swap" rel="stylesheet" />
<style>
@media (max-width: 600px) {
  .wrap { padding: 0 !important; }
  .card { width: 100% !important; border-radius: 0 !important; }
  .pad { padding-left: 22px !important; padding-right: 22px !important; }
  .col, .fact { display: block !important; width: 100% !important; padding: 0 0 12px 0 !important; }
  .sig-panel { display: block !important; width: 100% !important; padding: 0 0 14px 0 !important; }
  .sig-banner { width: 100% !important; max-width: 400px !important; height: auto !important; }
  .sig-details { display: block !important; border-left: 0 !important; padding-left: 0 !important; }
}
</style></head>`;

/** The body's blocks, with the message's action added if the body lost it — never sent without what it was sent for. */
function bodyRows(body: DocumentModel, action: string | null | undefined): DocumentRow[] {
  const rows = body.pages.flatMap((p) => p.rows);
  if (!action) return rows;
  const has = blocksOf(rows).some((b) =>
    (b.type === "emailButton" && b.token === action && !b.hidden) ||
    ((b.type === "text" || b.type === "heading") && JSON.stringify(b.value).includes(`"token":"${action}"`)));
  if (has) return rows;
  const button: DocumentBlock = { id: "auto-action", type: "emailButton", settings: {}, locked: false, hidden: false,
    token: action, label: LINK_FIELDS[action]?.label ?? "Open", style: "dark" };
  return [...rows, { id: "auto-action-row", columns: [{ id: "auto-action-col", widthPercent: 100, blocks: [button] }], settings: { gap: 16, keepTogether: false, keepWithNext: false } }];
}

export function renderEmailDocument(input: EmailRenderInput): RenderedEmail {
  const tokens = tokenMap(input.fields, input.brand);
  const accent = cssColor(input.brand.accent, CARD_ORANGE);
  const ctx: Ctx = { tokens, brand: input.brand, accent };

  const subjectTokens: Record<string, string> = Object.assign(Object.create(null), tokens);
  for (const f of SECRET_FIELDS) subjectTokens[f] = "";
  const subject = fill(input.body.email?.subject ?? "", subjectTokens).replace(/\s+/g, " ").trim();

  const body = bodyRows(input.body, input.action);
  const bodyHtml = body
    .map((row) => rowHtml(row, ctx))
    .filter(Boolean)
    .map((html) => `<tr><td class="pad" style="padding:0 40px;">${html}</td></tr>`)
    .join("");

  // The frame, row by row: its slots (header, body, signature, footer) have their own spacing.
  const frameRows = input.frame.pages.flatMap((p) => p.rows).map((row) => {
    const only = row.columns.length === 1 && row.columns[0].blocks.length === 1 ? row.columns[0].blocks[0] : null;
    if (only?.hidden) return "";
    switch (only?.type) {
      case "emailHeader":
        return `<tr><td style="padding:28px 0 0 0;">${headerHtml(input.brand)}</td></tr>`;
      case "emailBody":
        return `<tr><td style="padding:34px 0 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${bodyHtml}</table></td></tr>`;
      case "emailSignature":
        return `<tr><td class="pad" style="padding:0 40px 34px;">${signatureHtml(ctx)}</td></tr>`;
      case "emailFooter":
        return `<tr><td class="pad" align="center" style="border-top:1px solid #eef0f3;padding:20px 40px 26px;font-size:12px;line-height:1.7;color:${QUIET};">${footerHtml(only.note, ctx)}</td></tr>`;
      default: {
        const html = rowHtml(row, ctx);
        return html ? `<tr><td class="pad" style="padding:0 40px;">${html}</td></tr>` : "";
      }
    }
  });
  // A frame without a body slot would send an email with no message in it.
  const hasSlot = blocksOf(input.frame.pages.flatMap((p) => p.rows)).some((b) => b.type === "emailBody" && !b.hidden);
  const rows = hasSlot ? frameRows.join("") : `${frameRows.join("")}<tr><td style="padding:34px 0 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${bodyHtml}</table></td></tr>`;

  const html = `<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">${HEAD(subject)}
<body style="margin:0;padding:0;background-color:#f3f4f6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f4f6" style="background-color:#f3f4f6;"><tr><td class="wrap" align="center" style="padding:32px 16px;">
<table role="presentation" class="card" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:600px;max-width:600px;background-color:#ffffff;border-radius:16px;overflow:hidden;font-family:${EMAIL_FONT};">
${rows}
</table>
</td></tr></table>
</body>
</html>`;

  return { subject, html, text: plainText(body, ctx) };
}

/** The plain-text alternative every mail app falls back to: the message, its action, the sender. */
function plainText(rows: DocumentRow[], ctx: Ctx): string {
  const { tokens, brand } = ctx;
  const parts: string[] = [];
  for (const block of blocksOf(rows)) {
    if (block.hidden) continue;
    if (block.type === "text" || block.type === "heading") parts.push(richTextPlain(block.value, tokens));
    else if (block.type === "emailButton") {
      const value = tokens[block.token] ?? "";
      if (!value) continue;
      parts.push(block.token === "code" ? value : `${LINK_FIELDS[block.token]?.lead ?? `${fill(block.label, tokens)}:`}\n${value}`);
    } else if (block.type === "emailFacts") {
      parts.push(block.items.map((i) => `${fill(i.label, tokens)}: ${fill(i.value, tokens)}`).filter((l) => l.trim() !== ":").join("\n"));
    } else if (block.type === "image" && block.alt) parts.push(`[${block.alt}]`);
  }
  const sender = tokens.sender_name?.trim() || brand.companyName;
  const signature = [sender, sender === brand.companyName ? "" : brand.companyName, [brand.phone, brand.email, brand.website].filter(Boolean).join(" · ")].filter(Boolean);
  return [...parts.filter((p) => p.trim()), `--\n${signature.join("\n")}`].join("\n\n");
}

import { escapeHtml } from "@/lib/escapeHtml";

/**
 * FORMATTED EMAIL BODIES.
 *
 * The template editor is the same rich-text editor (Plate) the document editor
 * uses: bold/italic/underline, headings, bullet and numbered lists, links, and
 * merge fields as pills. What it produces is a JSON tree, and this module is the
 * only thing that turns that tree into an email — so the owner gets formatting,
 * but never raw HTML:
 *
 *   - `sanitizeEmailDoc` keeps an allow-list of node types and properties and
 *     drops everything else. Links must be http(s)/mailto. Merge fields must be
 *     ones this email kind offers. It runs on save AND on read.
 *   - `emailDocToHtml` writes inline-styled, table-free HTML (what every mail
 *     client, Outlook included, renders) and escapes every character of text.
 *   - `emailDocToText` gives the plain-text part, and the `{{field}}` text the
 *     existing validation reads, from the same tree.
 *
 * Pure (no DB) so tests drive it directly.
 */

export type EmailDocText = { text: string; bold?: true; italic?: true; underline?: true };
export type EmailDocInline =
  | EmailDocText
  | { type: "a"; url: string; children: EmailDocText[] }
  | { type: "mergeField"; token: string; children: [{ text: "" }] };
export type EmailDocBlock = {
  type: "p" | "h2" | "h3" | "blockquote";
  align?: "center" | "right";
  listStyleType?: "disc" | "decimal";
  indent?: number;
  children: EmailDocInline[];
};
export type EmailDoc = EmailDocBlock[];

const BLOCK_TYPES = new Set(["p", "h2", "h3", "blockquote"]);
const MAX_BLOCKS = 200;
const MAX_TEXT = 5000;
const MAX_URL = 2000;

/** A link the email may carry: http(s) or mailto only — never javascript:, data:, etc. */
export function safeEmailUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const url = raw.trim();
  if (!url || url.length > MAX_URL) return null;
  if (/^mailto:[^\s<>"]+$/i.test(url)) return url;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function cleanText(raw: unknown): EmailDocText | null {
  if (!raw || typeof raw !== "object") return null;
  const n = raw as Record<string, unknown>;
  if (typeof n.text !== "string") return null;
  const out: EmailDocText = { text: n.text };
  if (n.bold === true) out.bold = true;
  if (n.italic === true) out.italic = true;
  if (n.underline === true) out.underline = true;
  return out;
}

function cleanInline(raw: unknown, fields: ReadonlySet<string>): EmailDocInline[] {
  if (!raw || typeof raw !== "object") return [];
  const n = raw as Record<string, unknown>;
  if (n.type === "mergeField") {
    return typeof n.token === "string" && fields.has(n.token)
      ? [{ type: "mergeField", token: n.token, children: [{ text: "" }] }]
      : [];
  }
  if (n.type === "a") {
    const kids = (Array.isArray(n.children) ? n.children : []).map(cleanText).filter((t): t is EmailDocText => !!t);
    const url = safeEmailUrl(n.url);
    // An unsafe link keeps its words, loses the link.
    if (!url) return kids;
    return kids.length ? [{ type: "a", url, children: kids }] : [];
  }
  const t = cleanText(n);
  return t ? [t] : [];
}

/**
 * The editor's tree, reduced to what an email may contain. Returns null when
 * nothing usable is left (or it is too big) — the caller treats that as "no
 * formatted body" and falls back to the plain text.
 */
export function sanitizeEmailDoc(raw: unknown, fields: readonly string[]): EmailDoc | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_BLOCKS) return null;
  const allowed = new Set(fields);
  const doc: EmailDoc = [];
  let chars = 0;
  for (const b of raw) {
    if (!b || typeof b !== "object") continue;
    const n = b as Record<string, unknown>;
    const type = typeof n.type === "string" && BLOCK_TYPES.has(n.type) ? (n.type as EmailDocBlock["type"]) : "p";
    const children = (Array.isArray(n.children) ? n.children : []).flatMap((c) => cleanInline(c, allowed));
    for (const c of children) chars += "text" in c ? c.text.length : 0;
    const block: EmailDocBlock = { type, children: children.length ? children : [{ text: "" }] };
    if (n.align === "center" || n.align === "right") block.align = n.align;
    if (n.listStyleType === "disc" || n.listStyleType === "decimal") {
      block.listStyleType = n.listStyleType;
      block.indent = Math.min(4, Math.max(1, Number(n.indent) || 1));
    }
    doc.push(block);
  }
  if (chars > MAX_TEXT) return null;
  return doc.length ? doc : null;
}

function inlineText(n: EmailDocInline): string {
  if ("type" in n && n.type === "mergeField") return `{{${n.token}}}`;
  if ("type" in n && n.type === "a") {
    const words = n.children.map((c) => c.text).join("");
    return words && words !== n.url ? `${words} (${n.url})` : n.url;
  }
  return (n as EmailDocText).text;
}

const blockText = (b: EmailDocBlock) => b.children.map(inlineText).join("");

/** True when the block holds nothing but the one merge field `token` (the button / code line). */
export function isOnlyField(b: EmailDocBlock, token: string): boolean {
  const real = b.children.filter((c) => !("text" in c && !("type" in c) && c.text.trim() === ""));
  return real.length === 1 && "type" in real[0] && real[0].type === "mergeField" && real[0].token === token;
}

/**
 * The plain-text form, with `{{field}}` placeholders. Paragraphs are separated
 * by a blank line (the existing renderer's paragraph rule); consecutive list
 * items stay on adjacent lines.
 */
export function emailDocToText(doc: EmailDoc): string {
  const out: string[] = [];
  let n = 0;
  doc.forEach((b, i) => {
    const prev = doc[i - 1];
    const text = blockText(b).trim();
    if (b.listStyleType) {
      n = prev?.listStyleType === b.listStyleType ? n + 1 : 1;
      const bullet = b.listStyleType === "decimal" ? `${n}.` : "•";
      const line = `${"  ".repeat((b.indent ?? 1) - 1)}${bullet} ${text}`;
      if (prev?.listStyleType) out[out.length - 1] += `\n${line}`;
      else out.push(line);
      return;
    }
    n = 0;
    if (text) out.push(text);
  });
  return out.join("\n\n");
}

/** Text from a plain body → the editor's tree (so existing and default templates open formatted). */
export function textToEmailDoc(body: string, fields: readonly string[]): EmailDoc {
  const allowed = new Set(fields);
  const inline = (line: string): EmailDocInline[] => {
    const parts: EmailDocInline[] = [];
    let last = 0;
    for (const m of line.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
      if (m.index! > last) parts.push({ text: line.slice(last, m.index) });
      parts.push(allowed.has(m[1]) ? { type: "mergeField", token: m[1], children: [{ text: "" }] } : { text: m[0] });
      last = m.index! + m[0].length;
    }
    if (last < line.length) parts.push({ text: line.slice(last) });
    return parts.length ? parts : [{ text: "" }];
  };
  const blocks: EmailDoc = [];
  for (const para of body.replace(/\r\n?/g, "\n").trim().split(/\n\s*\n/)) {
    // Lines inside a paragraph keep their line breaks (Plate renders "\n" in a text leaf).
    blocks.push({ type: "p", children: inline(para) });
  }
  return blocks.length ? blocks : [{ type: "p", children: [{ text: "" }] }];
}

export type EmailDocRender = {
  /** Already-HTML-escaped values per field (the inline link/code forms included). */
  escaped: Record<string, string>;
  /** The paragraph style the shell uses. */
  paragraphStyle: string;
  accent: string;
  /** HTML for a block holding only the action field (the button / code box), or null if this kind has none. */
  actionBlock: ((token: string) => string | null) | null;
};

function inlineHtml(n: EmailDocInline, r: EmailDocRender): string {
  if ("type" in n && n.type === "mergeField") return r.escaped[n.token] ?? "";
  if ("type" in n && n.type === "a") {
    return `<a href="${escapeHtml(n.url)}" target="_blank" style="color:${r.accent};">${n.children.map((c) => inlineHtml(c, r)).join("")}</a>`;
  }
  const t = n as EmailDocText;
  let s = escapeHtml(t.text).replace(/\n/g, "<br>");
  if (!s) return "";
  if (t.bold) s = `<strong>${s}</strong>`;
  if (t.italic) s = `<em>${s}</em>`;
  if (t.underline) s = `<u>${s}</u>`;
  return s;
}

/**
 * Inline-styled HTML for the email body. Lists are grouped into real <ul>/<ol>
 * (Plate stores them as flagged paragraphs). A block that is only the action
 * field (the signing link / code) becomes the button / code box.
 */
export function emailDocToHtml(doc: EmailDoc, r: EmailDocRender): string {
  const P = r.paragraphStyle;
  const out: string[] = [];
  for (let i = 0; i < doc.length; i++) {
    const b = doc[i];
    if (b.listStyleType) {
      const tag = b.listStyleType === "decimal" ? "ol" : "ul";
      const items: string[] = [];
      while (i < doc.length && doc[i].listStyleType === b.listStyleType) {
        const it = doc[i];
        const pad = ((it.indent ?? 1) - 1) * 18;
        items.push(`<li style="margin:0 0 6px;${pad ? `margin-left:${pad}px;` : ""}">${it.children.map((c) => inlineHtml(c, r)).join("")}</li>`);
        i++;
      }
      i--;
      out.push(`<${tag} style="${P}padding-left:22px;">${items.join("")}</${tag}>`);
      continue;
    }
    const action = r.actionBlock;
    if (action) {
      const only = b.children.find((c) => "type" in c && c.type === "mergeField") as { token: string } | undefined;
      if (only && isOnlyField(b, only.token)) {
        const html = action(only.token);
        if (html) {
          out.push(html);
          continue;
        }
      }
    }
    const inner = b.children.map((c) => inlineHtml(c, r)).join("");
    const align = b.align ? `text-align:${b.align};` : "";
    if (b.type === "h2") out.push(`<h2 style="margin:0 0 12px;font-family:Helvetica,Arial,sans-serif;font-size:20px;line-height:1.3;color:#0f172a;${align}">${inner}</h2>`);
    else if (b.type === "h3") out.push(`<h3 style="margin:0 0 10px;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:1.35;color:#0f172a;${align}">${inner}</h3>`);
    else if (b.type === "blockquote") out.push(`<p style="${P}border-left:3px solid #e2e8f0;padding-left:12px;color:#475569;${align}">${inner}</p>`);
    else out.push(`<p style="${P}${align}">${inner || "&nbsp;"}</p>`);
  }
  return out.join("\n");
}

/**
 * A document's running header and footer: a line of text at the top and at the
 * foot of every printed sheet — left, centre and right — with the page number
 * ("Page {{page}} of {{pages}}") and any merge field.
 *
 * In the PDF they are CSS page-margin boxes: the browser sets them in the
 * page's own margin, on every sheet, and counts the sheets itself — so they
 * never overlap the content and are right however far a table runs on. (Checked
 * against the PDF engine driven as the app drives it.) On screen — the signing
 * page, the editor — the same words are drawn in the sheet's margin.
 *
 * They need a margin to live in: under MIN_RUNNING_MARGIN there is no room, and
 * nothing is drawn.
 */
import type { DocumentModel } from "./model";

export const MIN_RUNNING_MARGIN = 28;
const SLOTS = ["left", "centre", "right"] as const;
type Slot = (typeof SLOTS)[number];
type Tokens = { tokens?: Record<string, string>; bound?: boolean } | null | undefined;

/** Does this document have a running header or footer to draw (and a margin to draw it in)? */
export function hasRunning(doc: DocumentModel): boolean {
  const r = doc.running;
  return !!r && doc.style.margin >= MIN_RUNNING_MARGIN && [r.header, r.footer].some((line) => SLOTS.some((slot) => line[slot].trim()));
}

/**
 * Merge fields in a running line, EXCEPT the page counters, which only the page
 * being printed knows. Bound to a record, an unresolved field is dropped — a
 * customer must never read "{{…}}".
 */
function fill(text: string, ctx: Tokens): string {
  return (text ?? "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, key: string) => (key === "page" || key === "pages" ? `{{${key}}}` : ctx?.tokens?.[key] ?? (ctx?.bound ? "" : whole)));
}

/**
 * Text as a CSS string literal. Inside a <style> element, so as well as the
 * quote and the backslash it must not be able to end the element ("<") or the
 * line; anything that is not ordinary text becomes a CSS escape.
 */
export function cssString(text: string): string {
  return `"${[...text.replace(/[\r\n\t]+/g, " ")].map((ch) => (/[\\"<>&{}\u0000-\u001f\u007f]/.test(ch) ? `\\${ch.codePointAt(0)!.toString(16)} ` : ch)).join("")}"`;
}

/** `Page {{page}} of {{pages}}` → `"Page " counter(page) " of " counter(pages)`. */
function cssContent(text: string, ctx: Tokens): string {
  const parts = fill(text, ctx).split(/(\{\{pages?\}\})/).filter(Boolean);
  return parts.map((part) => (part === "{{page}}" ? "counter(page)" : part === "{{pages}}" ? "counter(pages)" : cssString(part))).join(" ");
}

const BOX: Record<"header" | "footer", Record<Slot, string>> = {
  header: { left: "@top-left", centre: "@top-center", right: "@top-right" },
  footer: { left: "@bottom-left", centre: "@bottom-center", right: "@bottom-right" },
};

/**
 * The rules for the printed page: `page` goes INSIDE the document's `@page { … }`
 * rule, `first` after it. Both are empty for a document with no running lines,
 * so its CSS is exactly what it always was.
 */
export function runningCss(doc: DocumentModel, ctx: Tokens, font: string): { page: string; first: string } {
  if (!hasRunning(doc)) return { page: "", first: "" };
  const r = doc.running!;
  const used: string[] = [];
  const rules = (["header", "footer"] as const).flatMap((line) => SLOTS.flatMap((slot) => {
    if (!r[line][slot].trim()) return [];
    used.push(BOX[line][slot]);
    return [`${BOX[line][slot]} { content: ${cssContent(r[line][slot], ctx)}; font: 8pt ${font}; color: #64748b; }`];
  }));
  return {
    page: `${rules.join(" ")} `,
    first: r.skipFirst ? ` @page :first { ${used.map((box) => `${box} { content: none; }`).join(" ")} }` : "",
  };
}

/** The same lines as plain text, for one sheet drawn on screen. Null when that sheet has none. */
export function runningText(doc: DocumentModel, ctx: Tokens, pageNumber: number, pageCount: number): { header: Record<Slot, string>; footer: Record<Slot, string> } | null {
  if (!hasRunning(doc) || (doc.running!.skipFirst && pageNumber === 1)) return null;
  const line = (which: "header" | "footer") => Object.fromEntries(SLOTS.map((slot) => [slot, fill(doc.running![which][slot], ctx).replace(/\{\{page\}\}/g, String(pageNumber)).replace(/\{\{pages\}\}/g, String(pageCount))])) as Record<Slot, string>;
  return { header: line("header"), footer: line("footer") };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Those lines as HTML laid in a sheet's top and bottom margin (sheet-edge coordinates) — for the signing page. */
export function runningSheetHtml(doc: DocumentModel, ctx: Tokens, pageNumber: number, pageCount: number, margin: number = doc.style.margin): string {
  const text = runningText(doc, ctx, pageNumber, pageCount);
  // `margin` is this sheet's own (a page may have one): with too little there is nowhere to set them, as in print.
  if (!text || margin < MIN_RUNNING_MARGIN) return "";
  const m = margin;
  const line = (words: Record<Slot, string>, edge: "top" | "bottom") =>
    `<div style="position:absolute;${edge}:0;left:${m}px;right:${m}px;height:${m}px;display:grid;grid-template-columns:1fr 1fr 1fr;align-items:center;font-size:8pt;line-height:1.2;color:#64748b;pointer-events:none"><span style="text-align:left">${esc(words.left)}</span><span style="text-align:center">${esc(words.centre)}</span><span style="text-align:right">${esc(words.right)}</span></div>`;
  return line(text.header, "top") + line(text.footer, "bottom");
}

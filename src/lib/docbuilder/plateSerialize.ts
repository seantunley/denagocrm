import type { MergeContext } from "./merge";

/**
 * Serialises a Plate/Slate document (plain JSON tree) to HTML, resolving
 * inline merge-field nodes against a record. Pure JSON walking — no Plate
 * dependency — so it runs server-side for the Chromium HTML→PDF path.
 */

type SlateText = { text?: string; bold?: boolean; italic?: boolean; underline?: boolean };
type SlateNode = SlateText & { type?: string; token?: string; align?: string; children?: SlateNode[] };

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Friendly label for a merge token, e.g. "customer.name" → "Customer name". */
export function prettyToken(token: string): string {
  const last = token.split(".").slice(-2).join(" ");
  const s = last.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[._]/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function plainText(node: SlateNode): string {
  if (typeof node.text === "string") return node.text;
  if (node.type === "mergeField" && node.token) return `{{${node.token}}}`;
  return (node.children ?? []).map(plainText).join("");
}

/** Data-bound line-items table — expands the record's items where {{items}} sits. */
function itemsTableHtml(ctx: MergeContext | null): string {
  const rows = ctx?.items ?? [];
  const head = `<tr><th style="width:52%">Description</th><th style="text-align:right">Qty</th><th style="text-align:right">Unit price</th><th style="text-align:right">Total</th></tr>`;
  const body = rows.length
    ? rows.map((r) => `<tr><td>${esc(r.cells[0]?.value ?? "")}</td><td style="text-align:right">${esc(r.cells[1]?.value ?? "")}</td><td style="text-align:right">${esc(r.cells[2]?.value ?? "")}</td><td style="text-align:right">${esc(r.cells[3]?.value ?? "")}</td></tr>`).join("")
    : `<tr><td colspan="4" style="color:#94a3b8">Line items appear here when linked to a record</td></tr>`;
  return `<table>${head}${body}</table>`;
}

function serializeNode(node: SlateNode, ctx: MergeContext | null): string {
  const tokens = ctx?.tokens ?? {};
  // text leaf — also resolve any {{token}} typed inline
  if (typeof node.text === "string") {
    const resolved = node.text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k: string) => tokens[k] ?? `{{${k}}}`);
    let t = esc(resolved);
    if (!t) return "";
    if (node.bold) t = `<strong>${t}</strong>`;
    if (node.italic) t = `<em>${t}</em>`;
    if (node.underline) t = `<u>${t}</u>`;
    return t;
  }
  // inline merge field → resolved value when bound, else a pill placeholder
  if (node.type === "mergeField" && node.token) {
    const val = tokens[node.token];
    if (val != null && val !== "") return esc(val);
    return `<span style="background:#fff7ed;border:1px solid #fed7aa;border-radius:4px;padding:0 5px;color:#c2410c;font-size:.9em">${esc(prettyToken(node.token))}</span>`;
  }
  // a block whose text is exactly {{items}} becomes the data-bound line-items table
  if (plainText(node).trim() === "{{items}}") return itemsTableHtml(ctx);

  const children = (node.children ?? []).map((c) => serializeNode(c, ctx)).join("");
  const style = node.align ? ` style="text-align:${node.align}"` : "";
  switch (node.type) {
    case "h1": return `<h1${style}>${children}</h1>`;
    case "h2": return `<h2${style}>${children}</h2>`;
    case "h3": return `<h3${style}>${children}</h3>`;
    case "blockquote": return `<blockquote${style}>${children}</blockquote>`;
    case "hr": return `<hr/>`;
    case "ul": return `<ul>${children}</ul>`;
    case "ol": return `<ol>${children}</ol>`;
    case "li": return `<li>${children}</li>`;
    case "table": return `<table>${children}</table>`;
    case "tr": return `<tr>${children}</tr>`;
    case "td": return `<td>${children}</td>`;
    case "th": return `<th>${children}</th>`;
    default: return `<p${style}>${children || "&nbsp;"}</p>`;
  }
}

export function plateToHtmlBody(nodes: SlateNode[], ctx: MergeContext | null): string {
  return (nodes ?? []).map((n) => serializeNode(n, ctx)).join("\n");
}

const HTML_FONTS: Record<string, string> = {
  sans: "Helvetica, Arial, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "'Courier New', monospace",
};
export function htmlFont(key?: string): string {
  return HTML_FONTS[String(key ?? "sans")] ?? HTML_FONTS.sans;
}

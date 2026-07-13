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

/**
 * Wrap serialized body in a print-ready A4 document. Any headerHtml / footerHtml
 * (e.g. the Banner / Footer blocks) become **repeating page furniture** via
 * CSS position:fixed, while the body flows inside. Reserves top/bottom space so
 * content never collides with them.
 */
export function wrapA4(
  bodyHtml: string,
  opts?: { headerHtml?: string; footerHtml?: string; font?: string; logoDataUri?: string }
): string {
  const font = opts?.font ?? HTML_FONTS.sans;
  const hasHeader = Boolean(opts?.headerHtml);
  const hasFooter = Boolean(opts?.footerHtml);
  const defaultHeader = `<div style="display:flex;align-items:center;justify-content:space-between;border-bottom:2px solid #020617;padding-bottom:4px">${
    opts?.logoDataUri
      ? `<img src="${opts.logoDataUri}" style="height:10mm" alt="Denago"/>`
      : `<span style="font-weight:700;font-size:13pt">DENAGO CAPE TOWN</span>`
  }<span style="font-size:8pt;color:#64748b">Authorized Denago EV Dealer</span></div>`;
  const defaultFooter = `<div style="border-top:2px solid #ea580c;padding-top:4px;text-align:center;font-size:7.5pt;color:#64748b">Denago Cape Town — Authorized Denago EV Dealer · Unit 55, M5 Freeway Business Park, Maitland · sales@denagocpt.co.za · denagocpt.co.za</div>`;
  const header = opts?.headerHtml ?? defaultHeader;
  const footer = opts?.footerHtml ?? defaultFooter;
  const padTop = hasHeader || !opts ? "32mm" : "16mm";
  const padBottom = hasFooter || !opts ? "24mm" : "16mm";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 0; }
    * { box-sizing: border-box; }
    body { font-family: ${font}; font-size: 11pt; line-height: 1.5; color: #1e293b; margin: 0; }
    .doc-content { padding: ${padTop} 16mm ${padBottom}; }
    .doc-header { position: fixed; top: 8mm; left: 16mm; right: 16mm; }
    .doc-footer { position: fixed; bottom: 8mm; left: 16mm; right: 16mm; }
    h1 { font-size: 20pt; margin: 0 0 8px; color: #020617; }
    h2 { font-size: 15pt; margin: 14px 0 6px; color: #020617; }
    h3 { font-size: 12pt; margin: 12px 0 4px; color: #020617; }
    p { margin: 0 0 8px; }
    blockquote { border-left: 3px solid #ea580c; margin: 8px 0; padding: 4px 12px; color: #475569; background: #f8fafc; }
    ul, ol { margin: 0 0 8px 20px; }
    hr { border: none; border-top: 1px solid #e2e8f0; margin: 12px 0; }
    table { width: 100%; border-collapse: collapse; margin: 8px 0; }
    td, th { border: 1px solid #e2e8f0; padding: 6px 8px; text-align: left; font-size: 10pt; }
    th { background: #020617; color: #fff; }
  </style></head><body>
    <div class="doc-header">${header}</div>
    <div class="doc-footer">${footer}</div>
    <div class="doc-content">${bodyHtml}</div>
  </body></html>`;
}

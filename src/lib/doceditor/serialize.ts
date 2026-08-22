/**
 * Read-only serialiser: DocumentModel → print-ready HTML for Chromium PDF.
 *
 * This is deliberately SEPARATE from the editor DOM (per spec): the editor is for
 * interaction; final pagination and output come from this pure renderer with
 * print CSS and explicit page-break handling. Optionally binds to a CRM record
 * (resolves inline variables, prunes conditionals, fills bound pricing tables).
 */
import { cssColor } from "./css";
import type {
  DocumentModel, DocumentBlock, DocumentColumn, DocumentRow, DocumentPage,
  PricingBlock, PricingLine, TableBlock, OverlayField, DocStyle,
} from "./model";
import { PAGE_SIZES } from "./model";
import { plateToHtmlBody } from "@/lib/docbuilder/plateSerialize";
import { evaluateCondition } from "@/lib/docbuilder/expr";
import { brandFooterContent, SOCIAL_ICON_PATHS } from "@/lib/companyBrand";

export type RenderCtx = {
  tokens: Record<string, string>;
  items: { cells: { value: string }[]; qty?: number; unitPrice?: number; discountPct?: number }[];
  vars: Record<string, unknown>;
  // True only when bound to a real CRM record. A context may be non-null yet unbound
  // — carrying just record-independent global tokens ({{company.*}}) for a "No record"
  // preview — in which case conditionals and showIf columns must render as the
  // placeholder layout, NOT be evaluated against an empty scope.
  bound?: boolean;
} | null;

function esc(s: unknown): string {
  // Attribute-safe: also escape quotes so values interpolated into style/src/attr can't break out.
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function nl2br(s: string): string { return esc(s).replace(/\n/g, "<br/>"); }
/** Resolve {{tokens}} in a plain string field against the bound record (kept literal for sample data). */
function tok(s: string, ctx: RenderCtx): string {
  return (s ?? "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k: string) => ctx?.tokens?.[k] ?? `{{${k}}}`);
}
function fontStack(f: DocStyle["fontFamily"]): string {
  return f === "serif" ? "Georgia, 'Times New Roman', serif" : f === "mono" ? "'Courier New', monospace" : "Helvetica, Arial, sans-serif";
}
function money(amount: number, currency: string): string {
  const sign = amount < 0 ? "-" : "";
  const n = Math.abs(amount).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === "ZAR" ? `${sign}R ${n}` : `${sign}${currency} ${n}`;
}

export function computePricing(block: PricingBlock): {
  rows: { line: PricingLine; net: number; tax: number; total: number }[]; subtotal: number; taxTotal: number; total: number;
} {
  const rows = block.lines.filter((l) => l.selected).map((line) => {
    const gross = line.qty * line.unitPrice;
    const net = gross * (1 - (line.discountPct || 0) / 100);
    const tax = block.showTax ? net * ((line.taxPct || 0) / 100) : 0;
    return { line, net, tax, total: net + tax };
  });
  const subtotal = rows.reduce((s, r) => s + r.net, 0);
  const taxTotal = rows.reduce((s, r) => s + r.tax, 0);
  return { rows, subtotal, taxTotal, total: subtotal + taxTotal };
}

function pricingHtml(block: PricingBlock, ctx: RenderCtx): string {
  const b: PricingBlock = block.bound && ctx?.items?.length
    ? { ...block, lines: ctx.items.map((it, i) => ({
        id: `bound-${i}`, name: it.cells[0]?.value ?? "", description: "", sku: "",
        qty: it.qty ?? (Number(it.cells[1]?.value) || 1),
        unitPrice: it.unitPrice ?? parseMoney(it.cells[2]?.value),
        discountPct: it.discountPct ?? 0, taxPct: 0,
        optional: false, selected: true,
      })) }
    : block;
  const { rows, subtotal, taxTotal, total } = computePricing(b);
  const cur = b.currency;
  const cols = ["Item", "Qty", "Unit", b.showDiscount ? "Disc" : null, b.showTax ? "Tax" : null, "Amount"].filter(Boolean) as string[];
  const head = cols.map((c, i) => `<th style="text-align:${i === 0 ? "left" : "right"};background:${cssColor(b.accent, "#ea580c")};color:#fff;padding:7px 9px;font-size:8pt;letter-spacing:.5px;text-transform:uppercase">${esc(c)}</th>`).join("");
  const body = rows.map((r, i) => {
    const cells = [
      `<td style="padding:7px 9px;border-bottom:.5px solid #e2e8f0"><div style="font-weight:600;color:#020617">${esc(r.line.name)}</div>${r.line.description ? `<div style="font-size:8pt;color:#64748b">${esc(r.line.description)}</div>` : ""}</td>`,
      `<td style="text-align:right;padding:7px 9px;border-bottom:.5px solid #e2e8f0">${esc(r.line.qty)}</td>`,
      `<td style="text-align:right;padding:7px 9px;border-bottom:.5px solid #e2e8f0">${money(r.line.unitPrice, cur)}</td>`,
      b.showDiscount ? `<td style="text-align:right;padding:7px 9px;border-bottom:.5px solid #e2e8f0">${r.line.discountPct || 0}%</td>` : "",
      b.showTax ? `<td style="text-align:right;padding:7px 9px;border-bottom:.5px solid #e2e8f0">${money(r.tax, cur)}</td>` : "",
      `<td style="text-align:right;padding:7px 9px;border-bottom:.5px solid #e2e8f0;font-weight:600">${money(r.total, cur)}</td>`,
    ].join("");
    return `<tr style="background:${i % 2 ? "#f8fafc" : "#fff"}">${cells}</tr>`;
  }).join("");
  const totals = `
    <div style="display:flex;justify-content:flex-end;margin-top:8px">
      <table style="font-size:10pt">
        <tr><td style="padding:2px 10px;color:#64748b">Subtotal</td><td style="padding:2px 0;text-align:right">${money(subtotal, cur)}</td></tr>
        ${b.showTax ? `<tr><td style="padding:2px 10px;color:#64748b">Tax</td><td style="padding:2px 0;text-align:right">${money(taxTotal, cur)}</td></tr>` : ""}
        <tr><td style="padding:6px 10px;font-weight:700;color:${cssColor(b.accent, "#ea580c")}">Total</td><td style="padding:6px 0;text-align:right;font-weight:700;font-size:12pt;color:${cssColor(b.accent, "#ea580c")}">${money(total, cur)}</td></tr>
      </table>
    </div>`;
  return `<div style="margin:6px 0"><table style="width:100%;border-collapse:collapse"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${totals}</div>`;
}
function parseMoney(s?: string): number {
  if (!s) return 0;
  const n = Number(String(s).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Value for one bound line-items column. Quote prices are VAT-INCLUSIVE, so the
 * cells give inclusive unit price + inclusive line total; the excl-VAT and VAT
 * figures are derived so a table using them adds up (excl + VAT = incl).
 */
function lineItemCell(key: string, row: { cells: { value: string }[] }, vatRate: number): string {
  const factor = 1 + (vatRate || 0) / 100;
  const inclUnit = parseMoney(row.cells[2]?.value);
  const inclTotal = parseMoney(row.cells[3]?.value);
  switch (key) {
    case "description": return row.cells[0]?.value ?? "";
    case "qty": return row.cells[1]?.value ?? "";
    case "unitPrice": return row.cells[2]?.value ?? "";        // incl VAT (as quoted)
    case "unitPriceExVat": return money(inclUnit / factor, "ZAR");
    case "vat": return money(inclTotal - inclTotal / factor, "ZAR");
    case "subtotal": return money(inclTotal / factor, "ZAR");  // line total excl VAT
    case "total": return row.cells[3]?.value ?? "";            // incl VAT
    default: return "";
  }
}

function tableHtml(b: TableBlock): string {
  const head = b.columns.map((c) => `<th style="text-align:${c.align};background:${cssColor(b.headerBg, "#020617")};color:${cssColor(b.headerColor, "#ffffff")};padding:6px 8px;font-size:8pt;width:${c.widthPct}%">${esc(c.header)}</th>`).join("");
  const body = b.rows.map((r, i) => `<tr style="background:${i % 2 ? "#f8fafc" : "#fff"}">${b.columns.map((c, ci) => `<td style="text-align:${c.align};padding:6px 8px;border-bottom:.5px solid #e2e8f0;font-size:10pt">${esc(r.cells[ci]?.value ?? "")}</td>`).join("")}</tr>`).join("");
  return `<table style="width:100%;border-collapse:collapse;margin:6px 0"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function blockHtml(block: DocumentBlock, ctx: RenderCtx, style: DocStyle, logoDataUri?: string): string {
  if (block.hidden) return "";
  const pad = block.settings?.padding;
  const padCss = pad ? `padding:${pad.top ?? 0}px ${pad.right ?? 0}px ${pad.bottom ?? 0}px ${pad.left ?? 0}px;` : "";
  const wrap = (inner: string) => `<div style="${padCss}">${inner}</div>`;
  switch (block.type) {
    case "heading":
    case "text":
      return wrap(plateToHtmlBody(block.value as never[], ctx as never));
    case "image": {
      const src = String(block.src || "").trim();
      if (!src || !/^(https:|data:image\/)/i.test(src)) return "";
      return wrap(`<img src="${esc(src)}" alt="${esc(block.alt)}" style="width:${Math.max(5, Math.min(100, block.widthPct))}%;height:auto;${block.rounded ? "border-radius:8px;" : ""}"/>`);
    }
    case "divider":
      return `<hr style="border:none;border-top:${block.thickness}px solid ${cssColor(block.color, "#ea580c")};margin:10px 0"/>`;
    case "spacer":
      return `<div style="height:${block.height}px"></div>`;
    case "pageBreak":
      return `<div style="page-break-after:always"></div>`;
    case "pricing":
      return wrap(pricingHtml(block, ctx));
    case "table":
      return wrap(tableHtml(block));
    case "banner": {
      const logo = block.showLogo && logoDataUri
        ? `<img src="${logoDataUri}" alt="Denago" style="height:34px;width:auto"/>`
        : `<span style="color:#fff;font-weight:800;font-size:15pt;letter-spacing:1px">DENAGO</span>`;
      return `<div style="background:${cssColor(block.bg, "#020617")};border-radius:8px;padding:16px 20px;display:flex;align-items:center;justify-content:space-between;margin:2px 0">
        <div>${logo}</div>
        <div style="text-align:right"><div style="color:#fff;font-weight:800;font-size:17pt;letter-spacing:1px">${esc(tok(block.title, ctx))}</div><div style="color:${cssColor(block.accent, "#ea580c")};font-weight:800;font-size:12pt">${esc(tok(block.docNumber, ctx))}</div></div>
      </div>`;
    }
    case "infoCard":
      return `<div style="background:#f8fafc;border-left:3px solid ${cssColor(block.accent, "#ea580c")};border-radius:6px;padding:12px 14px">
        <div style="font-size:8pt;font-weight:700;letter-spacing:1px;color:${cssColor(block.accent, "#ea580c")}">${esc(block.label)}</div>
        <div style="font-size:12pt;font-weight:700;color:${cssColor(style.ink, "#020617")};margin:3px 0">${esc(tok(block.name, ctx))}</div>
        <div style="font-size:9pt;color:#64748b">${nl2br(tok(block.lines, ctx))}</div>
      </div>`;
    case "lineItems": {
      const rows = ctx?.items ?? [];
      // Conditional columns: only when bound to a record, drop columns whose condition
      // is false. An unbound (globals-only) preview keeps all columns as a placeholder.
      const cols = ctx?.bound ? block.columns.filter((c) => evaluateCondition(c.showIf, ctx.vars)) : block.columns;
      const head = `<tr>${cols.map((c) => `<th style="text-align:${c.align};background:${cssColor(block.headerBg, "#020617")};color:${cssColor(block.headerColor, "#ffffff")};padding:7px 9px;font-size:8pt;letter-spacing:.5px;text-transform:uppercase">${esc(c.header)}</th>`).join("")}</tr>`;
      const body = rows.length
        ? rows.map((r, i) => `<tr style="background:${i % 2 ? "#f8fafc" : "#fff"}">${cols.map((c) => `<td style="text-align:${c.align};padding:7px 9px;border-bottom:.5px solid #e2e8f0">${esc(lineItemCell(c.key, r, block.vatRate))}</td>`).join("")}</tr>`).join("")
        : `<tr><td colspan="${cols.length}" style="padding:7px 9px;color:#94a3b8">Line items appear here when linked to a record</td></tr>`;
      return `<table style="width:100%;border-collapse:collapse;margin:6px 0"><thead>${head}</thead><tbody>${body}</tbody></table>`;
    }
    case "totalBand": {
      // The amount must never wrap. It is the one number on the page a reader
      // looks for, and a six-figure total breaking across two lines inside a
      // coloured band is the ugliest way a document can fail. nowrap makes the
      // band grow instead; the type scale is there for when growing is not
      // enough and the band has to share the row.
      const scale = block.settings?.fontScale ?? 1;
      const place =
        block.settings?.horizontalAlignment === "left"
          ? "flex-start"
          : block.settings?.horizontalAlignment === "centre"
            ? "center"
            : "flex-end";
      return `<div style="display:flex;justify-content:${place};margin:6px 0"><div style="background:${cssColor(block.color, "#ea580c")};color:#fff;border-radius:6px;padding:10px 20px;display:flex;gap:16px;align-items:center;max-width:100%"><span style="font-size:${(9 * scale).toFixed(2)}pt;font-weight:700;letter-spacing:1px;white-space:nowrap">${esc(block.label)}</span><span style="font-size:${(16 * scale).toFixed(2)}pt;font-weight:800;white-space:nowrap">${esc(tok(block.amount, ctx))}</span></div></div>`;
    }
    case "terms":
      return `<div style="background:#f8fafc;border-radius:6px;padding:12px 14px;margin:4px 0">${block.title ? `<div style="font-size:8pt;font-weight:700;letter-spacing:1px;color:#64748b;margin-bottom:6px">${esc(block.title)}</div>` : ""}${block.items.map((it) => `<div style="font-size:9pt;color:#64748b;margin-bottom:3px">• ${esc(it.text)}</div>`).join("")}</div>`;
    case "footer": {
      if (block.variant === "simple") {
        return `<div style="border-top:1.5px solid ${cssColor(block.accent, "#ea580c")};padding-top:8px;margin:6px 0;text-align:center">${block.lines.map((l, i) => `<div style="font-size:${i === 0 ? 9 : 8}pt;font-weight:${i === 0 ? 700 : 400};color:${i === 0 ? "#334155" : "#64748b"}">${esc(tok(l.text, ctx))}</div>`).join("")}</div>`;
      }
      const f = brandFooterContent((k) => ctx?.tokens?.[`company.${k}`] ?? "");
      const icon = (net: "facebook" | "instagram", color: string) =>
        `<svg width="13" height="13" viewBox="0 0 24 24" fill="${color}" style="display:inline-block;vertical-align:middle"><path d="${SOCIAL_ICON_PATHS[net]}"/></svg>`;
      const socials = `<div style="display:flex;align-items:center;gap:7px;white-space:nowrap">${icon("facebook", "#1877f2")}${icon("instagram", "#e4405f")}${f.instagram ? `<span style="font-size:8.5pt;color:#0f172a;font-weight:600">${esc(f.instagram)}</span>` : ""}</div>`;
      return `<div style="border-top:1px solid #e2e8f0;padding-top:9px;margin:8px 0;display:flex;justify-content:space-between;align-items:center;gap:18px">
        <div style="min-width:0">
          <div style="font-size:10pt;font-weight:700;color:#0f172a">${esc(f.title)}</div>
          ${f.contact ? `<div style="font-size:8.5pt;color:#64748b;margin-top:2px">${esc(f.contact)}</div>` : ""}
          ${f.web ? `<div style="font-size:8.5pt;color:#2563eb;margin-top:1px">${esc(f.web)}</div>` : ""}
        </div>
        ${socials}
      </div>`;
    }

    case "conditional": {
      // Only prune when bound to a record; an unbound preview renders all branches.
      if (ctx?.bound && !evaluateCondition(block.when, ctx.vars)) return "";
      return `<div>${block.blocks.map((c) => blockHtml(c, ctx, style, logoDataUri)).join("")}</div>`;
    }
  }
}

/**
 * Per-block box + type: width and placement within its column (PandaDoc-style
 * narrow blocks), plus the typography settings that apply to every block.
 *
 * `font-size` is emitted in em so it MULTIPLIES whatever the block sets for
 * itself — the blocks below express their sizes in points, and a scale is the
 * only way to change them without editing each one.
 */
function blockBoxStyle(b: DocumentBlock): string {
  const w = b.settings?.width;
  const align = b.settings?.horizontalAlignment;
  const scale = b.settings?.fontScale;
  const textAlign = b.settings?.textAlign;
  let style = "";
  if (w && w < 100) {
    const margin = align === "right" ? "0 0 0 auto" : align === "centre" ? "0 auto" : "0 auto 0 0";
    style += `width:${w}%;margin:${margin};`;
  }
  // totalBand sets its own point sizes from the scale (its type is fixed in pt,
  // so an inherited em would not reach it) — applying it here too would square it.
  if (scale && scale !== 1 && b.type !== "totalBand") style += `font-size:${scale}em;`;
  if (textAlign) style += `text-align:${textAlign === "centre" ? "center" : textAlign};`;
  return style;
}

function columnHtml(col: DocumentColumn, ctx: RenderCtx, style: DocStyle, logoDataUri?: string): string {
  return `<div style="min-width:0">${col.blocks.map((b) => {
    const inner = blockHtml(b, ctx, style, logoDataUri);
    const box = blockBoxStyle(b);
    return box ? `<div style="${box}">${inner}</div>` : inner;
  }).join("")}</div>`;
}

function rowHtml(row: DocumentRow, ctx: RenderCtx, style: DocStyle, logoDataUri?: string): string {
  const cols = row.columns;
  const template = cols.map((c) => `${c.widthPercent}fr`).join(" ");
  const gap = row.settings?.gap ?? 16;
  const keep = row.settings?.keepTogether ? "break-inside:avoid;" : "";
  return `<div style="display:grid;grid-template-columns:${template};gap:${gap}px;margin:2px 0;${keep}">${cols.map((c) => columnHtml(c, ctx, style, logoDataUri)).join("")}</div>`;
}

function overlayFieldHtml(f: OverlayField, recipientColor: string, margin: number): string {
  const label = f.label || f.kind.charAt(0).toUpperCase() + f.kind.slice(1);
  // Only page-anchored fields get an absolute position in the flowed PDF.
  if (f.anchor.mode !== "page") return "";
  // Editor coords are from the sheet edge; the PDF content box is inset by margin.
  return `<div style="position:absolute;left:${f.anchor.x - margin}px;top:${f.anchor.y - margin}px;width:${f.width}px;height:${f.height}px;border:1.5px dashed ${cssColor(recipientColor, "#2563eb")};border-radius:4px;background:${cssColor(recipientColor, "#2563eb")}14;display:flex;align-items:center;justify-content:center;font-size:9pt;color:${cssColor(recipientColor, "#2563eb")};font-weight:600">${esc(label)}</div>`;
}

/** A signed field to stamp into the finished PDF at its exact placed position. */
export type StampField = {
  page: number; x: number; y: number; width: number; height: number;
  kind: string; image?: string; text?: string; label?: string;
};

/** Render one signed field at its placed coordinates (no dashed placeholder). */
function stampFieldHtml(s: StampField, margin: number): string {
  const left = s.x - margin, top = s.y - margin;
  const pos = `position:absolute;left:${left}px;top:${top}px;width:${s.width}px;height:${s.height}px;`;
  if ((s.kind === "signature" || s.kind === "initials" || s.kind === "stamp") && s.image) {
    // Baseline rule under the ink, signer label beneath — a familiar signature line.
    return `<div style="${pos}display:flex;flex-direction:column;justify-content:flex-end">
      <img src="${esc(s.image)}" style="max-width:100%;max-height:${Math.max(20, s.height - 14)}px;object-fit:contain;object-position:left bottom"/>
      <div style="border-top:1px solid #334155;margin-top:2px;font-size:7pt;color:#64748b">${esc(s.label || "")}</div>
    </div>`;
  }
  if (s.kind === "checkbox") {
    return `<div style="${pos}display:flex;align-items:center;justify-content:center;font-size:14pt;color:#020617;font-weight:700">${s.text === "✓" ? "✓" : ""}</div>`;
  }
  // text / date / other typed values
  return `<div style="${pos}display:flex;align-items:flex-end;font-size:10pt;color:#020617;border-bottom:1px solid #334155;padding-bottom:1px;overflow:hidden">${esc(s.text ?? "")}</div>`;
}

function pageHtml(page: DocumentPage, doc: DocumentModel, ctx: RenderCtx, logoDataUri?: string, isLast?: boolean, hideOverlays?: boolean, stamps?: StampField[]): string {
  const rows = page.rows.map((r) => rowHtml(r, ctx, doc.style, logoDataUri)).join("");
  // When stamping signed values, suppress the empty dashed template boxes.
  const fields = hideOverlays || stamps ? "" : page.overlayFields.map((f) => {
    const rc = doc.recipients.find((r) => r.id === f.recipientId)?.color ?? "#2563eb";
    return overlayFieldHtml(f, rc, doc.style.margin);
  }).join("");
  const stamped = (stamps ?? []).map((s) => stampFieldHtml(s, doc.style.margin)).join("");
  // Free-placement content: absolutely positioned within the page box (coords are
  // page-relative but the page margin already offsets the flow, so shift by margin).
  const floats = page.floatingBlocks.map((fb) =>
    `<div style="position:absolute;left:${fb.x - doc.style.margin}px;top:${fb.y - doc.style.margin}px;width:${fb.width}px">${blockHtml(fb.block, ctx, doc.style, logoDataUri)}</div>`
  ).join("");
  const size = PAGE_SIZES[doc.style.pageSize];
  return `<div class="doc-page" style="position:relative;min-height:${size.h - doc.style.margin * 2}px;${isLast ? "" : "page-break-after:always;"}">${rows}${fields}${floats}${stamped}</div>`;
}

/**
 * Restricted email-safe HTML: single flowing column (side-by-side columns are
 * stacked), inline styles, no fixed header/footer or absolute overlays — the
 * safest subset for email clients.
 */
export function renderEmailHtml(doc: DocumentModel, ctx: RenderCtx, logoDataUri?: string): string {
  const font = fontStack(doc.style.fontFamily);
  const parts: string[] = [];
  for (const page of doc.pages) for (const row of page.rows) for (const col of row.columns) for (const b of col.blocks) {
    parts.push(blockHtml(b, ctx, doc.style, logoDataUri));
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
  <body style="margin:0;background:#f1f5f9;padding:16px">
    <div style="max-width:640px;margin:0 auto;background:#fff;padding:24px;font-family:${font};font-size:14px;line-height:1.5;color:#1e293b">
      ${parts.join("")}
    </div>
  </body></html>`;
}

/**
 * Per-page "sheet" HTML for the interactive signing surface. Unlike the PDF
 * renderer this produces full A4 sheets (no @page margin) with content inset by
 * padding, so the client can overlay interactive field widgets at their exact
 * sheet-relative coordinates (matching the editor's origin — no margin subtract).
 * Overlay fields are intentionally omitted; the client renders live controls.
 */
export function renderSigningSheets(doc: DocumentModel, ctx: RenderCtx, logoDataUri?: string): { width: number; height: number; margin: number; css: string; pages: string[] } {
  const m = doc.style.margin;
  const size = PAGE_SIZES[doc.style.pageSize];
  const font = fontStack(doc.style.fontFamily);
  const pages = doc.pages.map((page) => {
    const rows = page.rows.map((r) => rowHtml(r, ctx, doc.style, logoDataUri)).join("");
    // Free-placement blocks sit at raw sheet coordinates (sheet edge origin).
    const floats = page.floatingBlocks.map((fb) =>
      `<div style="position:absolute;left:${fb.x}px;top:${fb.y}px;width:${fb.width}px">${blockHtml(fb.block, ctx, doc.style, logoDataUri)}</div>`
    ).join("");
    return `<div style="position:absolute;inset:0;padding:${m}px">${rows}</div>${floats}`;
  });
  const css = `
    .sg-sheet { font-family:${font}; font-size:11pt; line-height:1.5; color:#1e293b; }
    .sg-sheet * { box-sizing:border-box; }
    .sg-sheet h1 { font-size:20pt; margin:0 0 8px; color:${cssColor(doc.style.ink, "#020617")}; }
    .sg-sheet h2 { font-size:15pt; margin:12px 0 6px; color:${cssColor(doc.style.ink, "#020617")}; }
    .sg-sheet h3 { font-size:12pt; margin:10px 0 4px; color:${cssColor(doc.style.ink, "#020617")}; }
    .sg-sheet p { margin:0 0 8px; }
    .sg-sheet a { color:${cssColor(doc.style.accent, "#ea580c")}; }
    .sg-sheet strong { font-weight:700; }
    .sg-sheet blockquote { border-left:3px solid ${cssColor(doc.style.accent, "#ea580c")}; margin:8px 0; padding:4px 12px; color:#475569; background:#f8fafc; }
    .sg-sheet ul, .sg-sheet ol { margin:0 0 8px 20px; }`;
  return { width: size.w, height: size.h, margin: m, css, pages };
}

export function renderDocumentHtml(
  doc: DocumentModel,
  ctx: RenderCtx,
  logoDataUri?: string,
  opts?: {
    hideOverlays?: boolean;
    appendHtml?: string;
    stampedFields?: StampField[];
    /**
     * Screen-only chrome placed before the document — the Print / Back bar the
     * browser print page needs. Kept out of `appendHtml` because that lands
     * INSIDE the flow after the last page; this sits above it and is hidden by
     * `@media print`, so what prints is exactly what the PDF pipeline renders.
     */
    toolbarHtml?: string;
  },
): string {
  const font = fontStack(doc.style.fontFamily);
  const m = doc.style.margin;
  const header = doc.header.length ? doc.header.map((b) => blockHtml(b, ctx, doc.style, logoDataUri)).join("") : "";
  const footer = doc.footer.length ? doc.footer.map((b) => blockHtml(b, ctx, doc.style, logoDataUri)).join("") : "";
  const lastIdx = doc.pages.length - 1;
  const stamped = opts?.stampedFields;
  const body = doc.pages.map((p, i) => pageHtml(p, doc, ctx, logoDataUri, i === lastIdx && !opts?.appendHtml, opts?.hideOverlays, stamped ? stamped.filter((s) => s.page === i) : undefined)).join("") + (opts?.appendHtml ?? "");
  const pageCss = doc.style.pageSize === "A4" ? "A4" : "letter";
  const size = PAGE_SIZES[doc.style.pageSize];
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${pageCss}; margin: ${m}px; }
    * { box-sizing: border-box; }
    body { font-family: ${font}; font-size: 11pt; line-height: 1.5; color: #1e293b; margin: 0; }
    h1 { font-size: 20pt; margin: 0 0 8px; color: ${cssColor(doc.style.ink, "#020617")}; }
    h2 { font-size: 15pt; margin: 12px 0 6px; color: ${cssColor(doc.style.ink, "#020617")}; }
    h3 { font-size: 12pt; margin: 10px 0 4px; color: ${cssColor(doc.style.ink, "#020617")}; }
    p { margin: 0 0 8px; }
    a { color: ${cssColor(doc.style.accent, "#ea580c")}; }
    strong { font-weight: 700; }
    blockquote { border-left: 3px solid ${cssColor(doc.style.accent, "#ea580c")}; margin: 8px 0; padding: 4px 12px; color: #475569; background: #f8fafc; }
    ul, ol { margin: 0 0 8px 20px; }
    ${header ? `.doc-header { position: fixed; top: -${m - 8}px; left: 0; right: 0; }` : ""}
    ${footer ? `.doc-footer { position: fixed; bottom: -${m - 8}px; left: 0; right: 0; }` : ""}
    ${opts?.toolbarHtml ? "@media print { .doc-toolbar { display: none !important; } }" : ""}
    /*
     * ON SCREEN ONLY. The @page rule above sizes the PRINTED sheet and does
     * nothing in the browser window, so this rendered edge-to-edge across whatever
     * width the viewport happened to be - text flush against the left, the totals
     * bar stretched to the far right, nothing resembling the page that comes out
     * of the printer.
     *
     * Constrained to the real page width and given the margin as padding, so what
     * is on screen is the sheet. Wrapped in @media screen so the printed output
     * and the PDF pipeline are byte-for-byte unchanged - they must keep taking
     * their geometry from the @page rule, not from this.
     */
    @media screen {
      body { background: #e2e8f0; }
      .doc-page {
        width: ${size.w}px;
        margin: 16px auto;
        padding: ${m}px;
        background: #ffffff;
        box-shadow: 0 1px 3px rgba(15, 23, 42, 0.2);
      }
    }
  </style></head><body>
    ${opts?.toolbarHtml ?? ""}
    ${header ? `<div class="doc-header">${header}</div>` : ""}
    ${footer ? `<div class="doc-footer">${footer}</div>` : ""}
    ${body}
  </body></html>`;
}

/**
 * HTML for the showcase quotation — the premium quote layout
 * (standardTemplates.showcaseQuoteTemplate): the six showcase blocks, plus the
 * "showcase" look of the shared infoCard, lineItems and terms blocks. Called
 * from serialize.ts blockHtml and from the editor canvas, so the page designed
 * is the page printed.
 *
 * Same rules as serialize.ts: every text value through esc(), every colour
 * through cssColor(), and images only as inline `data:image/…` URLs (the PDF
 * renderer blocks outside hosts, and the private store has no public links).
 * Icons are inline SVG — no icon fonts or CDNs — so they print and sign.
 */
import { cssColor } from "./css";
import type {
  AcceptanceBlock, InfoCardBlock, LineItemsBlock, ShowcaseBlock, ShowcaseIcon, TermsBlock, VehicleShowcaseBlock,
} from "./model";
import type { RenderCtx } from "./serialize";
import { lineItemCell } from "./serialize";
import { evaluateCondition } from "@/lib/docbuilder/expr";
import { SOCIAL_ICON_PATHS } from "@/lib/companyBrand";
import { modelName, readShowcase, type VehicleShowcaseData } from "@/lib/docbuilder/vehicleShowcase";
import { SHOWCASE_BAND_ASSETS } from "./showcaseAssets";

const INK = "#0b1220";
const ACCENT = "#ea580c";
/** Keeps dark bands dark when printed from a browser with "background graphics" off. */
const KEEP_BG = "-webkit-print-color-adjust:exact;print-color-adjust:exact;";
/** The content column's inset from the page edge. The header/footer bands and the hero photo bleed past it. */
export const SHOWCASE_INSET = 28;

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
/**
 * {{tokens}} against the record. Bound to a real record, an unresolved token
 * becomes EMPTY — a customer must never read "{{…}}". Unbound (template
 * preview), it stays visible so the designer can see what binds where.
 */
function tok(s: string, ctx: RenderCtx): string {
  return (s ?? "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k: string) => ctx?.tokens?.[k] ?? (ctx?.bound ? "" : `{{${k}}}`));
}
const isDataImage = (src: string) => /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(src);
/** "Unit price (incl. VAT)" → "Unit price" + a smaller "(incl. VAT)", as the design sets qualifiers. */
function withQualifier(text: string, qualifierStyle: string): string {
  const m = /^(.*?)\s*(\([^)]*\))\s*$/.exec(text);
  return m ? `${esc(m[1])} <span style="${qualifierStyle}">${esc(m[2])}</span>` : esc(text);
}

// ── icons ───────────────────────────────────────────────────────────
/** Outline icons (stroked). */
const LINE: Record<string, string> = {
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  calendarCheck: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/><rect x="13" y="13.5" width="4" height="4" rx=".6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  pin: '<path d="M12 21s-6-5.5-6-10a6 6 0 0 1 12 0c0 4.5-6 10-6 10z"/><circle cx="12" cy="11" r="2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 11h6M9 14h6M9 17h4"/>',
  checkbox: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m7.5 12 3 3 6-6.5"/>',
};
/** Solid glyphs for the spec circles. */
const GLYPH: Record<ShowcaseIcon, string> = {
  seats: '<circle cx="9" cy="7.5" r="3.3"/><circle cx="16.8" cy="8.6" r="2.7"/><path d="M2.5 19.5c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6v1h-13z"/><path d="M15.2 13.9c.5-.1 1-.2 1.6-.2 2.9 0 4.7 2 4.7 4.8v2h-4.4v-1c0-2.2-.7-4.1-1.9-5.6z"/>',
  range: '<path fill-rule="evenodd" d="M12 4.5A10 10 0 0 0 2.6 18l.3.6h18.2l.3-.6A10 10 0 0 0 12 4.5zm0 2.3a7.7 7.7 0 0 1 7.5 9.5h-15A7.7 7.7 0 0 1 12 6.8z"/><path d="M10.8 15.2l5.4-5.6 1 .9-4.7 6a1.7 1.7 0 1 1-1.7-1.3z"/>',
  speed: '<path fill-rule="evenodd" d="M12 4.5A10 10 0 0 0 2.6 18l.3.6h18.2l.3-.6A10 10 0 0 0 12 4.5zm0 2.3a7.7 7.7 0 0 1 7.5 9.5h-15A7.7 7.7 0 0 1 12 6.8z"/><path d="M10.8 15.2l5.4-5.6 1 .9-4.7 6a1.7 1.7 0 1 1-1.7-1.3z"/>',
  electric: '<path fill-rule="evenodd" d="M3 6.5h15a2 2 0 0 1 2 2v1h1.8v5H20v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zm.3 2.3v6.4h14.4V8.8z"/><rect x="4.6" y="10.2" width="3.2" height="3.6"/><rect x="8.9" y="10.2" width="3.2" height="3.6"/><rect x="13.2" y="10.2" width="3.2" height="3.6"/>',
  battery: '<path fill-rule="evenodd" d="M3 6.5h15a2 2 0 0 1 2 2v1h1.8v5H20v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zm.3 2.3v6.4h14.4V8.8z"/><rect x="4.6" y="10.2" width="3.2" height="3.6"/><rect x="8.9" y="10.2" width="3.2" height="3.6"/><rect x="13.2" y="10.2" width="3.2" height="3.6"/>',
  premium: '<path fill-rule="evenodd" d="M6.4 3.5h11.2l4.2 5.3L12 21 2.2 8.8zm1 2L5.2 8.1h3.4l1-2.6zm4 0-1 2.6h3.2l-1-2.6zm3.8 0 1 2.6h3.4l-2.2-2.6zM5.4 10l5.4 6.7-2-6.7zm5.3 0 1.3 5.3 1.3-5.3zm4.5 0-2 6.7 5.4-6.7z"/>',
  warranty: '<path d="M12 2 4 5v6c0 5.2 3.4 9.3 8 11 4.6-1.7 8-5.8 8-11V5z"/>',
  charge: '<path d="M8 2h2v5h4V2h2v5h2v5a6 6 0 0 1-5 5.9V22h-2v-4.1A6 6 0 0 1 6 12V7h2z"/>',
  calendar: '<path d="M7 2h2v2h6V2h2v2h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2zm-2 8v10h14V10z"/>',
  calendarCheck: '<path d="M7 2h2v2h6V2h2v2h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2zm-2 8v10h14V10z"/>',
  clock: '<path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm-1 5v6l5 3 1-1.6-4-2.4V7z"/>',
  user: '<circle cx="12" cy="7.5" r="4.5"/><path d="M3.5 21c0-4.4 3.8-7.5 8.5-7.5s8.5 3.1 8.5 7.5z"/>',
};
function lineIcon(name: string, color: string, size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${cssColor(color, INK)}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="display:block;flex:none">${LINE[name] ?? LINE.calendar}</svg>`;
}
function glyph(name: ShowcaseIcon, color: string, size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${cssColor(color, INK)}" style="display:block">${GLYPH[name] ?? GLYPH.premium}</svg>`;
}

// ── fixed geometry (overlay fields sit on these lines) ─────────────
/**
 * Fixed geometry of the acceptance card, in px. The customer's signature and
 * date are OVERLAY fields at page coordinates, and only a card of known height
 * lets the template put them exactly on its lines — see showcaseQuoteTemplate.
 */
export const ACCEPTANCE_GEOMETRY = { pad: 12, padX: 14, headerH: 22, headerGap: 6, textH: 30, nameRowH: 30, sigRowH: 40, dateRowH: 30, labelW: 92, gap: 6 } as const;
export function acceptanceHeight(): number {
  const g = ACCEPTANCE_GEOMETRY;
  return g.pad * 2 + g.headerH + g.headerGap + g.textH + g.nameRowH + g.sigRowH + g.dateRowH;
}
/** Fixed too, so the band placed at the foot of the sheet can never spill onto a second page. */
export const FOOTER_BAND_HEIGHT = 100;
/** The slim header band repeated at the top of a continuation page. */
export const SHOWCASE_COMPACT_HEADER_HEIGHT = 72;

/** Card header used by the terms and acceptance cards: dark icon, orange rule, bold caps title. */
function cardHeader(iconName: string, title: string, accentCss: string, height: number): string {
  return `<div style="display:flex;align-items:center;gap:8px;height:${height}px">${lineIcon(iconName, INK, 17)}<span style="width:3px;height:15px;background:${accentCss};border-radius:1px;${KEEP_BG}"></span><span style="font-size:8.5pt;font-weight:800;letter-spacing:.8px;color:${INK};text-transform:uppercase">${esc(title)}</span></div>`;
}
const CARD = `background:#f3f4f6;border-radius:6px;${KEEP_BG}`;

// ── bands ───────────────────────────────────────────────────────────
/**
 * A band's background: its photo (an upload, or the built-in Cape Town
 * default), cover-fit and centred, under a navy overlay that is darkest where
 * the text sits and light elsewhere so the scenery reads. With no photo, the
 * plain dark gradient. The built-in defaults arrive as data URLs from the
 * server (showcaseAssetsServer.ts); only the editor canvas sees their public
 * path, never a PDF or signing page.
 */
function bandBackground(bgCss: string, raw: string, ctx: RenderCtx, overlay: string): string {
  const img = tok(raw, ctx).trim();
  const usable = isDataImage(img) || (Object.values(SHOWCASE_BAND_ASSETS) as string[]).includes(img);
  const layers = usable ? `${overlay},url('${img}')` : `linear-gradient(115deg,${bgCss} 0%,${bgCss} 45%,#16233d 100%)`;
  return `background-color:${bgCss};background-image:${layers};background-size:cover;background-position:center;background-repeat:no-repeat;${KEEP_BG}`;
}
// Legibility comes from the overlay alone. A blurred text-shadow was tried and
// Chrome's PDF output (and some viewers) rasterise each shadowed run into a
// visible grey rectangle behind the logo, tagline, title and footer lines.
const HEADER_OVERLAY = "linear-gradient(90deg,rgba(11,18,32,.9) 0%,rgba(11,18,32,.66) 34%,rgba(11,18,32,.3) 68%,rgba(11,18,32,.5) 100%),linear-gradient(rgba(11,18,32,.1),rgba(11,18,32,.1))";
const FOOTER_OVERLAY = "linear-gradient(90deg,rgba(11,18,32,.88) 0%,rgba(11,18,32,.66) 40%,rgba(11,18,32,.6) 100%),linear-gradient(rgba(11,18,32,.14),rgba(11,18,32,.14))";
const TEXT_SHADOW = "";

// ── vehicle ─────────────────────────────────────────────────────────
/** Placeholder the template preview and the editor canvas show in place of a real vehicle. */
const SAMPLE_VEHICLE: VehicleShowcaseData = {
  name: "Model name",
  tagline: "Tagline from the product page",
  description: "The quoted vehicle's description, specs and photo fill in from its product (Products → the model → Quote showcase).",
  image: null,
  specs: [
    { icon: "seats", label: "4 SEATS", sub: "Comfortable seating" },
    { icon: "range", label: "64 KM", sub: "Typical range (per charge)" },
    { icon: "electric", label: "ELECTRIC", sub: "Quiet & emissions-free" },
    { icon: "premium", label: "PREMIUM", sub: "Stylish design and finish" },
  ],
};

/**
 * The vehicle to show: the one FROZEN into a signing snapshot when there is one
 * (authoritative — never the live product), else the record's, a name-only
 * fallback, the sample (unbound), or null (hide).
 */
function vehicleFor(block: VehicleShowcaseBlock, ctx: RenderCtx): VehicleShowcaseData | null {
  if (block.frozen !== undefined) return block.frozen ? readShowcase({ showcase: block.frozen }) : null;
  if (!ctx?.bound) return SAMPLE_VEHICLE;
  const found = readShowcase(ctx.vars);
  if (found) return found;
  const name = (ctx.tokens?.vehicle ?? "").trim();
  return name && name !== "—" ? { name, tagline: "", description: "", image: null, specs: [] } : null;
}

/**
 * The hero's size for this document's row count (see the block's `shrink`):
 * full height up to `afterRows`, then a smaller photo and COMPACT details so a
 * few more line items fit on the page before anything moves to page 2.
 */
function heroFit(b: VehicleShowcaseBlock, ctx: RenderCtx): { height: number; compact: boolean } {
  const full = Math.max(120, Math.min(520, b.imageHeight || 280));
  const s = b.shrink;
  const rows = ctx?.layoutRows ?? 0;
  if (!s || rows <= s.afterRows || rows > s.untilRows) return { height: full, compact: false };
  return { height: Math.max(s.minHeight, full - (rows - s.afterRows) * s.perRow), compact: true };
}

function vehicleDetailsHtml(b: VehicleShowcaseBlock, v: VehicleShowcaseData, compact = false): string {
  // Compact: the same content, tighter — smaller model name and spec circles, a
  // one-line description, spec labels without their sub-lines.
  const circle = compact ? 32 : 42;
  const specs = v.specs.length
    ? `<div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-top:${compact ? 6 : 12}px">${v.specs.map((s) => `<div style="text-align:center;min-width:0">
        <div style="width:${circle}px;height:${circle}px;border-radius:50%;border:1.3px solid ${INK};margin:0 auto ${compact ? 3 : 5}px;display:flex;align-items:center;justify-content:center">${glyph(s.icon, INK, compact ? 17 : 22)}</div>
        <div style="font-size:7.5pt;font-weight:800;color:${INK};text-transform:uppercase;line-height:1.2">${esc(s.label)}</div>
        ${s.sub && !compact ? `<div style="font-size:6.5pt;color:#6b7280;line-height:1.3;margin-top:1px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(s.sub)}</div>` : ""}
      </div>`).join("")}</div>`
    : "";
  return `<div style="position:relative;z-index:1;margin:${compact ? 8 : 14}px 0 0">
    ${b.brand.trim() ? `<div style="font-size:${compact ? 9 : 10}pt;font-weight:800;letter-spacing:.5px;color:${INK};text-transform:uppercase">${esc(b.brand)}</div>` : ""}
    <div style="font-size:${compact ? 25 : 34}pt;font-weight:900;line-height:1;color:${INK};text-transform:uppercase;letter-spacing:.3px;margin:1px 0 ${compact ? 3 : 5}px">${esc(modelName(v.name, b.brand))}</div>
    ${v.tagline ? `<div style="font-size:${compact ? 9.5 : 10.5}pt;font-weight:700;color:${INK};line-height:1.3;margin-bottom:${compact ? 2 : 4}px">${esc(v.tagline)}</div>` : ""}
    ${v.description ? `<div style="font-size:8.5pt;line-height:1.4;color:#4b5563;display:-webkit-box;-webkit-line-clamp:${compact ? 1 : 4};-webkit-box-orient:vertical;overflow:hidden">${esc(v.description)}</div>` : ""}
    ${specs}
  </div>`;
}

/**
 * The vehicle photo. "cover" fills the hero (bleeding to the page edge when the
 * row lets it) and fades softly into the white page along its LEFT edge, so a
 * scenic shot blends in; "contain" shows a cut-out whole and unfaded — faded, a
 * cut-out would lose the front of the vehicle.
 */
function vehicleImageHtml(b: VehicleShowcaseBlock, v: VehicleShowcaseData, bound: boolean, h: number): string {
  if (v.image && isDataImage(v.image)) {
    if (b.imageFit === "cover") {
      // Reaches a quarter of its width back under the text column (which sits
      // above it — see z-index on the details and PREPARED FOR card) so the fade
      // happens behind the copy, as in the design.
      const fade = "linear-gradient(to right,transparent 0%,rgba(0,0,0,.3) 16%,rgba(0,0,0,.85) 34%,#000 46%)";
      return `<div style="position:relative;z-index:0;height:${h}px;overflow:hidden;margin-left:-25%;width:125%"><img src="${esc(v.image)}" alt="${esc(v.name)}" style="display:block;width:100%;height:${h}px;object-fit:cover;object-position:center;-webkit-mask-image:${fade};mask-image:${fade}"/></div>`;
    }
    return `<div style="height:${h}px;display:flex;align-items:center;justify-content:center;background:radial-gradient(ellipse at 50% 62%,#eef2f7 0%,#ffffff 72%);${KEEP_BG}"><img src="${esc(v.image)}" alt="${esc(v.name)}" style="display:block;max-width:100%;max-height:${h}px;object-fit:contain"/></div>`;
  }
  // No photo on a real quote: leave the space empty rather than show a broken image.
  if (bound) return "";
  return `<div style="height:${h}px;display:flex;align-items:center;justify-content:center;border:1.5px dashed #cbd5e1;background:#f8fafc;color:#94a3b8;font-size:9pt;text-align:center;padding:12px">Vehicle photo of the quoted model</div>`;
}

// ── showcase looks of shared blocks ─────────────────────────────────
function preparedForHtml(b: InfoCardBlock, ctx: RenderCtx): string {
  const lines = tok(b.lines, ctx).split("\n").map((l) => l.trim()).filter(Boolean);
  const row = (text: string) => {
    const ic = /@/.test(text) ? "mail" : /^[+\d()][\d\s()+-]{5,}$/.test(text) ? "phone" : "";
    return `<div style="display:flex;align-items:center;gap:8px;font-size:9pt;color:#1f2937;line-height:1.4">${ic ? lineIcon(ic, INK, 13) : ""}<span>${esc(text)}</span></div>`;
  };
  return `<div style="${CARD}position:relative;z-index:1;margin-top:12px;border-left:4px solid ${cssColor(b.accent, ACCENT)};border-radius:4px;padding:9px 16px;background:rgba(243,244,246,.94)">
    <div style="font-size:7.5pt;font-weight:800;letter-spacing:.8px;color:${cssColor(b.accent, ACCENT)};text-transform:uppercase">${esc(b.label)}</div>
    <div style="font-size:13pt;font-weight:800;color:${INK};margin:2px 0 3px">${esc(tok(b.name, ctx))}</div>
    ${lines.map(row).join("")}
  </div>`;
}

function lineItemsHtml(b: LineItemsBlock, ctx: RenderCtx): string {
  const rows = ctx?.items ?? [];
  const cols = ctx?.bound ? b.columns.filter((c) => evaluateCondition(c.showIf, ctx.vars)) : b.columns;
  const border = "1px solid #e5e7eb";
  // Fixed column widths, shared by header and body. With auto layout and
  // nowrap headers, a long header ("TOTAL (INCL. VAT)") set its column's width,
  // pushed the table past the page edge, and the header no longer lined up with
  // the rows beneath. Description takes what the numeric columns leave.
  // Qty 9%; the money columns share 50%; the first (description) column gets the rest.
  const moneyCols = cols.filter((c, i) => i > 0 && c.key !== "qty").length;
  const widths = cols.map((c, i) => (i === 0 ? null : c.key === "qty" ? 9 : Math.floor(50 / Math.max(1, moneyCols))));
  const colgroup = `<colgroup>${cols.map((_, i) => `<col${widths[i] != null ? ` style="width:${widths[i]}%"` : ""}>`).join("")}</colgroup>`;
  const head = cols.map((c, i) => {
    const radius = i === 0 ? "border-top-left-radius:6px;" : i === cols.length - 1 ? "border-top-right-radius:6px;" : "";
    // A faint divider in the header on the same edges as the body's cell borders.
    const divider = i ? "border-left:1px solid rgba(255,255,255,.14);" : "";
    return `<th style="text-align:${c.align};background:${cssColor(b.headerBg, INK)};color:${cssColor(b.headerColor, "#ffffff")};padding:9px 12px;font-size:7.5pt;font-weight:800;letter-spacing:.4px;text-transform:uppercase;line-height:1.25;${divider}${radius}${KEEP_BG}">${withQualifier(c.header, "font-size:6pt;font-weight:600")}</th>`;
  }).join("");
  const cell = (c: (typeof cols)[number], i: number, row: number, value: string) =>
    `<td style="text-align:${c.align};padding:7px 12px;font-size:9pt;color:#1f2937;border-bottom:${border};${i ? `border-left:${border};` : `border-left:${border};`}${i === cols.length - 1 ? `border-right:${border};` : ""}${row % 2 ? `background:#f8fafc;${KEEP_BG}` : ""}">${esc(value)}</td>`;
  const body = rows.length
    ? rows.map((r, ri) => `<tr>${cols.map((c, i) => cell(c, i, ri, lineItemCell(c.key, r, b.vatRate, ctx?.regional))).join("")}</tr>`).join("")
    : `<tr><td colspan="${cols.length}" style="padding:9px 12px;color:#94a3b8;font-size:9pt;border:${border};border-top:none">Line items appear here when linked to a record</td></tr>`;
  return `<table style="width:100%;table-layout:fixed;border-collapse:separate;border-spacing:0;margin:8px 0 0">${colgroup}<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function termsHtml(b: TermsBlock, ctx: RenderCtx): string {
  const dot = `<span style="width:5px;height:5px;border-radius:50%;background:${ACCENT};flex:none;margin-top:5px;${KEEP_BG}"></span>`;
  // The same height as the acceptance card beside it (at least), so the pair reads as one row.
  return `<div style="${CARD}box-sizing:border-box;min-height:${acceptanceHeight()}px;padding:12px 14px">
    ${cardHeader("doc", b.title, ACCENT, 22)}
    <div style="margin-top:6px">${b.items.map((it) => `<div style="display:flex;gap:7px;font-size:7.5pt;line-height:1.4;color:#4b5563;margin-bottom:3px">${dot}<span>${esc(tok(it.text, ctx))}</span></div>`).join("")}</div>
  </div>`;
}

/** The showcase look of a shared block (infoCard / lineItems / terms), for serialize.ts and the canvas. */
export function showcaseLookHtml(block: InfoCardBlock | LineItemsBlock | TermsBlock, ctx: RenderCtx): string {
  if (block.type === "infoCard") return preparedForHtml(block, ctx);
  if (block.type === "lineItems") return lineItemsHtml(block, ctx);
  return termsHtml(block, ctx);
}

function acceptanceHtml(b: AcceptanceBlock, ctx: RenderCtx): string {
  const g = ACCEPTANCE_GEOMETRY;
  const line = (label: string, height: number, value = "") =>
    `<div style="display:flex;align-items:flex-end;gap:${g.gap}px;height:${height}px">
      <div style="width:${g.labelW}px;flex:none;font-size:8pt;font-weight:600;color:${INK};padding-bottom:3px;line-height:1.2">${esc(label)}</div>
      <div style="flex:1;min-width:0;height:100%;border-bottom:1px solid #6b7280;display:flex;align-items:flex-end;padding-bottom:3px;font-size:9pt;font-weight:600;color:${INK};line-height:1.2;white-space:nowrap;overflow:hidden">${esc(value)}</div>
    </div>`;
  const colon = (s: string) => (s.trim() && !s.trim().endsWith(":") ? `${s.trim()}:` : s);
  return `<div style="${CARD}box-sizing:border-box;height:${acceptanceHeight()}px;overflow:hidden;padding:${g.pad}px ${g.padX}px">
    ${cardHeader("checkbox", b.title, ACCENT, g.headerH)}
    <div style="height:${g.textH}px;margin-top:${g.headerGap}px;overflow:hidden;font-size:7.5pt;line-height:1.45;color:#4b5563">${esc(tok(b.text, ctx))}</div>
    ${line(colon(b.nameLabel), g.nameRowH, tok(b.nameValue, ctx))}
    ${line(colon(b.signatureLabel), g.sigRowH)}
    ${line(colon(b.dateLabel), g.dateRowH)}
  </div>`;
}

// ── the six showcase blocks ─────────────────────────────────────────
export function showcaseBlockHtml(block: ShowcaseBlock, ctx: RenderCtx, logoDataUri?: string): string {
  switch (block.type) {
    case "showcaseHeader": {
      const bgCss = cssColor(block.bg, INK);
      const accentCss = cssColor(block.accent, ACCENT);
      // Compact: the band repeated on a continuation page — slimmer, no tagline.
      const c = Boolean(block.compact);
      const logo = block.showLogo && logoDataUri
        ? `<img src="${esc(logoDataUri)}" alt="" style="height:${c ? 30 : 46}px;width:auto;display:block"/>`
        : `<div style="color:#fff;font-weight:800;font-size:${c ? 14 : 18}pt;letter-spacing:2px;${TEXT_SHADOW}">${esc(tok("{{company.name}}", ctx))}</div>`;
      return `<div style="${bandBackground(bgCss, block.bgImage, ctx, HEADER_OVERLAY)}box-sizing:border-box;min-height:${c ? SHOWCASE_COMPACT_HEADER_HEIGHT : 118}px;padding:${c ? 12 : 20}px ${SHOWCASE_INSET}px;display:flex;align-items:center;justify-content:space-between;gap:18px">
        <div style="min-width:0">${logo}${block.tagline.trim() && !c ? `<div style="color:#f1f5f9;font-size:7.5pt;font-weight:600;letter-spacing:3.5px;margin-top:10px;text-transform:uppercase;${TEXT_SHADOW}">${esc(tok(block.tagline, ctx))}</div>` : ""}</div>
        <div style="display:flex;align-items:stretch;gap:14px;flex:none">
          <div style="width:3px;background:${accentCss};border-radius:2px;${KEEP_BG}"></div>
          <div style="text-align:right">
            <div style="color:#fff;font-weight:800;font-size:${c ? 15 : 21}pt;letter-spacing:1.5px;line-height:1.15;${TEXT_SHADOW}">${esc(tok(block.title, ctx))}</div>
            <div style="color:${accentCss};font-weight:800;font-size:${c ? 11 : 14}pt;letter-spacing:1px;white-space:nowrap;${TEXT_SHADOW}">${esc(tok(block.docNumber, ctx))}</div>
          </div>
        </div>
      </div>`;
    }
    case "infoStrip": {
      if (!block.items.length) return "";
      return `<div style="display:grid;grid-template-columns:repeat(${block.items.length},1fr);padding:10px 0;border-bottom:1px solid #e5e7eb">${block.items.map((it, i) => `<div style="display:flex;gap:10px;align-items:center;min-width:0;padding:0 14px;${i ? "border-left:1px solid #d1d5db;" : "padding-left:4px;"}">
          ${lineIcon(it.icon, INK, 22)}
          <div style="min-width:0;line-height:1.3">
            <div style="font-size:6.5pt;font-weight:600;letter-spacing:1px;color:#6b7280;text-transform:uppercase">${esc(tok(it.label, ctx))}</div>
            <div style="font-size:10pt;font-weight:800;color:${INK}">${esc(tok(it.value, ctx))}</div>
            ${it.sub.trim() ? `<div style="font-size:7pt;color:#6b7280">${esc(tok(it.sub, ctx))}</div>` : ""}
          </div>
        </div>`).join("")}</div>`;
    }
    case "vehicleShowcase": {
      const v = vehicleFor(block, ctx);
      if (!v) return "";
      const bound = Boolean(ctx?.bound) || block.frozen !== undefined;
      const fit = heroFit(block, ctx);
      if (block.part === "details") return vehicleDetailsHtml(block, v, fit.compact);
      if (block.part === "image") return vehicleImageHtml(block, v, bound, fit.height);
      const image = vehicleImageHtml(block, v, bound, fit.height);
      return image
        ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:center">${vehicleDetailsHtml(block, v, fit.compact)}${image}</div>`
        : vehicleDetailsHtml(block, v, fit.compact);
    }
    case "totalsBox": {
      const accentCss = cssColor(block.accent, ACCENT);
      const rows = block.rows.map((r) => `<div style="display:flex;justify-content:space-between;gap:16px;padding:3px 14px;font-size:9pt;color:${INK}"><span style="font-weight:700">${withQualifier(tok(r.label, ctx), "font-weight:400;color:#6b7280")}</span><span style="white-space:nowrap">${esc(tok(r.value, ctx))}</span></div>`).join("");
      return `<div style="margin:10px 0 0">${rows ? `<div style="background:#f3f4f6;border-radius:4px;padding:5px 0;${KEEP_BG}">${rows}</div>` : ""}
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:6px;padding:9px 14px;border-radius:4px;border-left:6px solid ${accentCss};background:${cssColor(block.bg, INK)};${KEEP_BG}">
          <span style="color:#fff;font-size:7.5pt;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;white-space:nowrap">${esc(tok(block.totalLabel, ctx))}</span>
          <span style="color:${accentCss};font-size:18pt;font-weight:800;white-space:nowrap">${esc(tok(block.totalAmount, ctx))}</span>
        </div>
      </div>`;
    }
    case "acceptance":
      return acceptanceHtml(block, ctx);
    case "footerBand": {
      const accentCss = cssColor(block.accent, ACCENT);
      const bandBgCss = cssColor(block.bg, INK);
      const company = (k: string) => tok(`{{company.${k}}}`, ctx).trim();
      const item = (ic: string, text: string, clamp = 1) => text
        ? `<div style="display:flex;align-items:flex-start;gap:7px;min-width:0;color:#fff;font-size:7.5pt;line-height:1.35">${lineIcon(ic, accentCss, 13)}<span style="display:-webkit-box;-webkit-line-clamp:${clamp};-webkit-box-orient:vertical;overflow:hidden">${esc(text)}</span></div>`
        : "";
      const facebook = company("facebook");
      const instagram = company("instagram");
      const social = (net: "facebook" | "instagram") =>
        `<span style="width:22px;height:22px;border-radius:50%;border:1.3px solid #fff;display:inline-flex;align-items:center;justify-content:center"><svg width="12" height="12" viewBox="0 0 24 24" fill="#fff" style="display:block"><path d="${SOCIAL_ICON_PATHS[net]}"/></svg></span>`;
      const socials = [facebook ? social("facebook") : "", instagram ? social("instagram") : ""].filter(Boolean);
      const handle = instagram || facebook;
      return `<div style="${bandBackground(bandBgCss, block.bgImage, ctx, FOOTER_OVERLAY)}border-top:3px solid ${accentCss};box-sizing:border-box;height:${FOOTER_BAND_HEIGHT}px;overflow:hidden;padding:0 ${SHOWCASE_INSET}px;display:flex;align-items:center;gap:22px;${TEXT_SHADOW}">
        <div style="flex:0 0 190px;min-width:0">
          <div style="color:#fff;font-size:13pt;font-weight:800;line-height:1.25">${esc(company("name"))}</div>
          ${block.subtitle.trim() ? `<div style="color:#fff;font-size:9pt;margin-top:3px">${esc(tok(block.subtitle, ctx))}</div>` : ""}
        </div>
        <div style="flex:1;min-width:0;display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:6px 18px;align-items:start">
          <div style="display:grid;gap:5px;min-width:0">${item("pin", company("address"), 2)}${item("phone", company("phone"))}${item("globe", company("website"))}</div>
          <div style="display:grid;gap:5px;min-width:0;padding-top:${company("address") ? 22 : 0}px">${item("mail", company("email"))}</div>
        </div>
        ${socials.length ? `<div style="flex:none;text-align:center"><div style="display:flex;gap:7px;justify-content:center">${socials.join("")}</div>${handle ? `<div style="color:#fff;font-size:7.5pt;margin-top:5px">${esc(handle)}</div>` : ""}</div>` : ""}
      </div>`;
    }
  }
}

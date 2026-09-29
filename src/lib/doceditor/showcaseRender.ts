/**
 * HTML for the showcase quotation blocks — the premium quote layout
 * (standardTemplates.showcaseQuoteTemplate). Called from serialize.ts blockHtml,
 * and from the editor canvas, so the page designed is the page printed.
 *
 * Same rules as serialize.ts: every text value through esc(), every colour
 * through cssColor(), and images only as inline `data:image/…` URLs (the PDF
 * renderer blocks outside hosts, and the private store has no public links).
 */
import { cssColor } from "./css";
import type { AcceptanceBlock, ShowcaseBlock, ShowcaseIcon, VehicleShowcaseBlock } from "./model";
import type { RenderCtx } from "./serialize";
import { SOCIAL_ICON_PATHS } from "@/lib/companyBrand";
import { modelName, readShowcase, type VehicleShowcaseData } from "@/lib/docbuilder/vehicleShowcase";

const INK = "#020617";
const ACCENT = "#ea580c";
/** Keeps dark bands dark when printed from a browser with "background graphics" off. */
const KEEP_BG = "-webkit-print-color-adjust:exact;print-color-adjust:exact;";

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

const ICON_PATHS: Record<ShowcaseIcon | "pin" | "phone" | "globe" | "mail", string> = {
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  seats: '<path d="M6 11V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v5"/><path d="M4 11h16v5H4zM6 16v4M18 16v4"/>',
  range: '<path d="M12 21s-6-5.5-6-10a6 6 0 0 1 12 0c0 4.5-6 10-6 10z"/><circle cx="12" cy="11" r="2"/>',
  electric: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  premium: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3l-5.5 2.9 1-6.2L3 9.6l6.2-.9z"/>',
  speed: '<path d="M4 16a8 8 0 1 1 16 0"/><path d="m12 16 4-5"/>',
  battery: '<rect x="2" y="7" width="18" height="10" rx="2"/><path d="M22 11v2M6 10v4M10 10v4"/>',
  warranty: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  charge: '<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4"/>',
  pin: '<path d="M12 21s-6-5.5-6-10a6 6 0 0 1 12 0c0 4.5-6 10-6 10z"/><circle cx="12" cy="11" r="2"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
};
function icon(name: keyof typeof ICON_PATHS, color: string, size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${cssColor(color, ACCENT)}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="display:block">${ICON_PATHS[name] ?? ""}</svg>`;
}

/**
 * Fixed geometry of the acceptance card, in px. The customer's signature and
 * date are OVERLAY fields at page coordinates, and only a card of known height
 * lets the template put them exactly on its lines — see showcaseQuoteTemplate.
 */
export const ACCEPTANCE_GEOMETRY = { pad: 10, titleH: 18, textH: 28, nameRowH: 28, sigRowH: 44, dateRowH: 28, labelW: 84, gap: 8 } as const;
/** Fixed too, so the band placed at the foot of the sheet can never spill onto a second page. */
export const FOOTER_BAND_HEIGHT = 56;
export function acceptanceHeight(): number {
  const g = ACCEPTANCE_GEOMETRY;
  return g.pad * 2 + g.titleH + g.textH + g.nameRowH + g.sigRowH + g.dateRowH;
}

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

/** The vehicle to show: the record's, a name-only fallback, the sample (unbound), or null (hide). */
function vehicleFor(ctx: RenderCtx): VehicleShowcaseData | null {
  if (!ctx?.bound) return SAMPLE_VEHICLE;
  const found = readShowcase(ctx.vars);
  if (found) return found;
  const name = (ctx.tokens?.vehicle ?? "").trim();
  return name && name !== "—" ? { name, tagline: "", description: "", image: null, specs: [] } : null;
}

function vehicleDetailsHtml(b: VehicleShowcaseBlock, v: VehicleShowcaseData): string {
  const accentCss =cssColor(b.accent, ACCENT);
  const specs = v.specs.length
    ? `<div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-top:9px">${v.specs.map((s) => `<div style="text-align:center;min-width:0">
        <div style="width:32px;height:32px;border-radius:50%;border:1.5px solid ${accentCss};margin:0 auto 4px;display:flex;align-items:center;justify-content:center">${icon(s.icon, accentCss, 16)}</div>
        <div style="font-size:7.5pt;font-weight:800;color:#0f172a;letter-spacing:.5px;text-transform:uppercase;line-height:1.2">${esc(s.label)}</div>
        ${s.sub ? `<div style="font-size:6.5pt;color:#64748b;line-height:1.3;margin-top:1px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(s.sub)}</div>` : ""}
      </div>`).join("")}</div>`
    : "";
  return `<div style="margin:8px 0 0">
    ${b.brand.trim() ? `<div style="font-size:8pt;font-weight:700;letter-spacing:3px;color:${accentCss};text-transform:uppercase">${esc(b.brand)}</div>` : ""}
    <div style="font-size:28pt;font-weight:900;line-height:1.05;color:${INK};text-transform:uppercase;letter-spacing:.5px;margin:2px 0 4px">${esc(modelName(v.name, b.brand))}</div>
    ${v.tagline ? `<div style="font-size:10.5pt;font-weight:600;color:#334155;line-height:1.3">${esc(v.tagline)}</div>` : ""}
    <div style="width:40px;height:3px;background:${accentCss};border-radius:2px;margin:6px 0;${KEEP_BG}"></div>
    ${v.description ? `<div style="font-size:9pt;line-height:1.4;color:#475569;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden">${esc(v.description)}</div>` : ""}
    ${specs}
  </div>`;
}

function vehicleImageHtml(b: VehicleShowcaseBlock, v: VehicleShowcaseData, bound: boolean): string {
  const h = Math.max(120, Math.min(520, b.imageHeight || 280));
  const box = `height:${h}px;display:flex;align-items:center;justify-content:center;margin:8px 0 0;border-radius:12px;`;
  if (v.image && isDataImage(v.image)) {
    return `<div style="${box}background:radial-gradient(ellipse at 50% 62%,#eef2f7 0%,#ffffff 72%);${KEEP_BG}"><img src="${esc(v.image)}" alt="${esc(v.name)}" style="max-width:100%;max-height:${h}px;object-fit:contain"/></div>`;
  }
  // No photo on a real quote: leave the space empty rather than show a broken image.
  if (bound) return "";
  return `<div style="${box}border:1.5px dashed #cbd5e1;background:#f8fafc;color:#94a3b8;font-size:9pt;text-align:center;padding:12px">Vehicle photo of the quoted model</div>`;
}

function acceptanceHtml(b: AcceptanceBlock, ctx: RenderCtx): string {
  const g = ACCEPTANCE_GEOMETRY;
  const line = (label: string, height: number, value = "") =>
    `<div style="display:flex;align-items:flex-end;gap:${g.gap}px;height:${height}px">
      <div style="width:${g.labelW}px;flex:none;font-size:8pt;color:#64748b;padding-bottom:3px;line-height:1.2">${esc(label)}</div>
      <div style="flex:1;min-width:0;height:100%;border-bottom:1px solid #94a3b8;display:flex;align-items:flex-end;padding-bottom:3px;font-size:9.5pt;font-weight:600;color:#0f172a;line-height:1.2;white-space:nowrap;overflow:hidden">${esc(value)}</div>
    </div>`;
  // Styled to match the terms block it sits beside.
  return `<div style="box-sizing:border-box;height:${acceptanceHeight()}px;overflow:hidden;background:#f8fafc;border-radius:6px;padding:${g.pad}px 14px;${KEEP_BG}">
    <div style="height:${g.titleH}px;font-size:8pt;font-weight:700;letter-spacing:1px;color:#64748b;line-height:${g.titleH}px">${esc(b.title)}</div>
    <div style="height:${g.textH}px;overflow:hidden;font-size:8pt;line-height:1.45;color:#475569">${esc(tok(b.text, ctx))}</div>
    ${line(b.nameLabel, g.nameRowH, tok(b.nameValue, ctx))}
    ${line(b.signatureLabel, g.sigRowH)}
    ${line(b.dateLabel, g.dateRowH)}
  </div>`;
}

export function showcaseBlockHtml(block: ShowcaseBlock, ctx: RenderCtx, logoDataUri?: string): string {
  switch (block.type) {
    case "showcaseHeader": {
      const bgCss = cssColor(block.bg, INK);
      const accentCss =cssColor(block.accent, ACCENT);
      const photo = isDataImage(block.bgImage.trim())
        ? `linear-gradient(90deg,rgba(2,6,23,.94) 0%,rgba(2,6,23,.72) 55%,rgba(2,6,23,.45) 100%),url("${block.bgImage.trim()}")`
        : `linear-gradient(115deg,${bgCss} 0%,${bgCss} 45%,#16233d 100%)`;
      const logo = block.showLogo && logoDataUri
        ? `<img src="${esc(logoDataUri)}" alt="" style="height:36px;width:auto;display:block"/>`
        : `<div style="color:#fff;font-weight:800;font-size:16pt;letter-spacing:2px">${esc(tok("{{company.name}}", ctx))}</div>`;
      return `<div style="border-radius:10px;overflow:hidden;background-color:${bgCss};background-image:${photo};background-size:cover;background-position:center;padding:16px 24px;display:flex;align-items:center;justify-content:space-between;gap:18px;margin:0 0 8px;${KEEP_BG}">
        <div style="min-width:0">${logo}${block.tagline.trim() ? `<div style="color:#cbd5e1;font-size:7.5pt;font-weight:600;letter-spacing:3.5px;margin-top:9px;text-transform:uppercase">${esc(tok(block.tagline, ctx))}</div>` : ""}</div>
        <div style="display:flex;align-items:stretch;gap:14px;flex:none">
          <div style="width:3px;background:${accentCss};border-radius:2px;${KEEP_BG}"></div>
          <div style="text-align:right">
            <div style="color:#fff;font-weight:800;font-size:20pt;letter-spacing:3px;line-height:1.15">${esc(tok(block.title, ctx))}</div>
            <div style="color:${accentCss};font-weight:800;font-size:13pt;letter-spacing:1px;white-space:nowrap">${esc(tok(block.docNumber, ctx))}</div>
          </div>
        </div>
      </div>`;
    }
    case "infoStrip": {
      const accentCss =cssColor(block.accent, ACCENT);
      if (!block.items.length) return "";
      return `<div style="display:grid;grid-template-columns:repeat(${block.items.length},1fr);border:1px solid #e2e8f0;border-radius:8px;margin:0 0 4px;background:#fff">${block.items.map((it, i) => `<div style="display:flex;gap:10px;align-items:center;padding:6px 14px;min-width:0;${i ? "border-left:1px solid #e2e8f0;" : ""}">
          <div style="width:30px;height:30px;flex:none;border-radius:50%;background:#f1f5f9;display:flex;align-items:center;justify-content:center;${KEEP_BG}">${icon(it.icon, accentCss,16)}</div>
          <div style="min-width:0;line-height:1.3">
            <div style="font-size:6.5pt;font-weight:700;letter-spacing:1.5px;color:#64748b;text-transform:uppercase">${esc(tok(it.label, ctx))}</div>
            <div style="font-size:10pt;font-weight:700;color:#0f172a">${esc(tok(it.value, ctx))}</div>
            ${it.sub.trim() ? `<div style="font-size:7.5pt;color:#64748b">${esc(tok(it.sub, ctx))}</div>` : ""}
          </div>
        </div>`).join("")}</div>`;
    }
    case "vehicleShowcase": {
      const v = vehicleFor(ctx);
      if (!v) return "";
      const bound = Boolean(ctx?.bound);
      if (block.part === "details") return vehicleDetailsHtml(block, v);
      if (block.part === "image") return vehicleImageHtml(block, v, bound);
      const image = vehicleImageHtml(block, v, bound);
      return image
        ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:center">${vehicleDetailsHtml(block, v)}${image}</div>`
        : vehicleDetailsHtml(block, v);
    }
    case "totalsBox": {
      const rows = block.rows.map((r) => `<div style="display:flex;justify-content:space-between;gap:12px;padding:5px 14px;font-size:9pt;color:#475569;border-bottom:1px solid #eef2f7"><span>${esc(tok(r.label, ctx))}</span><span style="font-weight:600;color:#0f172a;white-space:nowrap">${esc(tok(r.value, ctx))}</span></div>`).join("");
      return `<div style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;background:#fff;margin:10px 0 0">${rows}
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 14px;background:${cssColor(block.bg, INK)};${KEEP_BG}">
          <span style="color:#fff;font-size:8.5pt;font-weight:700;letter-spacing:1.5px;white-space:nowrap">${esc(tok(block.totalLabel, ctx))}</span>
          <span style="color:${cssColor(block.accent, ACCENT)};font-size:16pt;font-weight:800;white-space:nowrap">${esc(tok(block.totalAmount, ctx))}</span>
        </div>
      </div>`;
    }
    case "acceptance":
      return acceptanceHtml(block, ctx);
    case "footerBand": {
      const accentCss =cssColor(block.accent, ACCENT);
      const company = (k: string) => tok(`{{company.${k}}}`, ctx).trim();
      const contact = ([["pin", "address"], ["phone", "phone"], ["globe", "website"], ["mail", "email"]] as const)
        .map(([ic, key]) => [ic, company(key)] as const)
        .filter(([, value]) => value);
      const instagram = company("instagram");
      const cell = (glyph: string, text: string) => `<div style="display:flex;align-items:center;gap:6px;min-width:0;color:#cbd5e1;font-size:7.5pt;line-height:1.3">${glyph}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(text)}</span></div>`;
      const cells = [
        ...contact.map(([ic, value]) => cell(icon(ic, accentCss,12), value)),
        ...(instagram ? [cell(`<svg width="12" height="12" viewBox="0 0 24 24" fill="${accentCss}" style="display:block;flex:none"><path d="${SOCIAL_ICON_PATHS.instagram}"/></svg>`, instagram)] : []),
      ];
      return `<div style="background:${cssColor(block.bg, INK)};border-top:3px solid ${accentCss};border-radius:8px;box-sizing:border-box;height:${FOOTER_BAND_HEIGHT}px;overflow:hidden;padding:0 18px;display:flex;justify-content:space-between;align-items:center;gap:16px;${KEEP_BG}">
        <div style="flex:none;max-width:40%">
          <div style="color:#fff;font-size:10.5pt;font-weight:800;line-height:1.25">${esc(company("name"))}</div>
          ${block.subtitle.trim() ? `<div style="color:${accentCss};font-size:7pt;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;margin-top:2px">${esc(tok(block.subtitle, ctx))}</div>` : ""}
        </div>
        <div style="display:grid;grid-template-columns:repeat(3,minmax(0,auto));gap:5px 16px;min-width:0">${cells.join("")}</div>
      </div>`;
    }
  }
}

/**
 * The warranty certificate's cover table (block "warrantyCover"): one row per part — Part · Cover · Covered until —
 * filled from the record's `vars.warranty.parts` (lib/warrantyCertificate.ts). Unbound (the editor, a preview with no
 * vehicle) it shows sample rows so the layout can be seen. Pure.
 */
import type { WarrantyCoverBlock } from "./model";

export type CoverRow = { part: string; cover: string; until: string; lifetime: boolean };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const hex = (value: string | undefined, fallback: string) => (value && /^#[0-9a-f]{3,8}$/i.test(value) ? value : fallback);

export const SAMPLE_COVER: CoverRow[] = [
  { part: "Battery", cover: "5 years", until: "21 Nov 2031", lifetime: false },
  { part: "Cart", cover: "2 years", until: "21 Nov 2028", lifetime: false },
  { part: "Chassis", cover: "Lifetime", until: "For life", lifetime: true },
];

function rowsFrom(ctx: { vars?: Record<string, unknown>; bound?: boolean } | null): CoverRow[] {
  const parts = (ctx?.vars?.warranty as { parts?: unknown } | undefined)?.parts;
  if (!Array.isArray(parts)) return ctx?.bound ? [] : SAMPLE_COVER;
  return parts
    .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === "object")
    .map((p) => ({ part: String(p.part ?? ""), cover: String(p.cover ?? ""), until: String(p.until ?? ""), lifetime: Boolean(p.lifetime) }))
    .filter((p) => p.part);
}

export function warrantyCoverHtml(block: WarrantyCoverBlock, ctx: { vars?: Record<string, unknown>; bound?: boolean } | null): string {
  const accent = hex(block.accent, "#ea580c");
  const rows = rowsFrom(ctx);
  const body = rows.length
    ? rows.map((r, i) => `<tr style="background:${i % 2 ? "#fbfaf7" : "#ffffff"}">
        <td style="padding:10px 14px;border-bottom:1px solid #ece6da;font-size:11pt;font-weight:600;color:#0f172a">${esc(r.part)}</td>
        <td style="padding:10px 14px;border-bottom:1px solid #ece6da;font-size:11pt;color:#334155">${esc(r.cover)}</td>
        <td style="padding:10px 14px;border-bottom:1px solid #ece6da;font-size:11pt;color:#334155;text-align:right">${r.lifetime
          ? `<span style="display:inline-block;padding:2px 10px;border-radius:999px;background:${accent};color:#fff;font-size:8.5pt;font-weight:700;letter-spacing:.6px">FOR LIFE</span>`
          : esc(r.until)}</td>
      </tr>`).join("")
    : `<tr><td colspan="3" style="padding:12px 14px;font-size:10pt;color:#64748b">No warranty recorded for this vehicle.</td></tr>`;
  return `<div style="margin:8px 0;break-inside:avoid">
    <div style="text-align:center;font-size:8.5pt;font-weight:700;letter-spacing:3px;color:${accent};margin-bottom:6px">${esc(block.title || "WARRANTY COVER")}</div>
    <table style="width:100%;border-collapse:collapse;border:1.5px solid ${accent};border-radius:8px;overflow:hidden">
      <thead><tr style="background:#0f172a">
        <th style="padding:8px 14px;text-align:left;font-size:8pt;letter-spacing:1.5px;color:#fff">PART</th>
        <th style="padding:8px 14px;text-align:left;font-size:8pt;letter-spacing:1.5px;color:#fff">COVER</th>
        <th style="padding:8px 14px;text-align:right;font-size:8pt;letter-spacing:1.5px;color:#fff">COVERED UNTIL</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

/**
 * The certificate's seal (Sean, 2026-11-21: "This must be improved"): a starburst in the accent colour, a dark medallion
 * with a fine gold ring, "WARRANTY · CERTIFIED ·" set round it on a circle, and a shield with a tick in the middle. A data
 * URL for an image block.
 */
export function warrantySealDataUri(accent = "#ea580c"): string {
  const c = hex(accent, "#ea580c");
  const INK = "#0f172a";
  const GOLD = "#d4a64a";
  const points = 40;
  const burst = Array.from({ length: points * 2 }, (_, i) => {
    const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? 78 : 70;
    return `${(80 + Math.cos(a) * r).toFixed(2)},${(80 + Math.sin(a) * r).toFixed(2)}`;
  }).join(" ");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160" width="160" height="160">
    <defs><path id="ring" d="M80,80 m-49,0 a49,49 0 1,1 98,0 a49,49 0 1,1 -98,0"/></defs>
    <polygon points="${burst}" fill="${c}"/>
    <circle cx="80" cy="80" r="66" fill="${INK}"/>
    <circle cx="80" cy="80" r="62" fill="none" stroke="${GOLD}" stroke-width="1.2"/>
    <circle cx="80" cy="80" r="37" fill="none" stroke="${GOLD}" stroke-width="1.2"/>
    <text font-family="Helvetica, Arial, sans-serif" font-size="11" font-weight="700" fill="#ffffff">
      <textPath href="#ring" startOffset="0" textLength="304" lengthAdjust="spacing">WARRANTY ★ CERTIFIED ★ WARRANTY ★ CERTIFIED ★</textPath>
    </text>
    <path d="M80 54 L101 62 V80 C101 94 92 103 80 108 C68 103 59 94 59 80 V62 Z" fill="${c}"/>
    <path d="M70 81 L77.5 88.5 L91 74" fill="none" stroke="#ffffff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  // URL-encoded, not base64: this module also runs in the editor (the browser), which has no Buffer.
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg.replace(/\s+/g, " "))}`;
}

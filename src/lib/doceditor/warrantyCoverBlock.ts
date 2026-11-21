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

/** The certificate's seal: a rosette in the accent colour with "WARRANTY · CERTIFIED". A data URL for an image block. */
export function warrantySealDataUri(accent = "#ea580c"): string {
  const c = hex(accent, "#ea580c");
  const teeth = Array.from({ length: 24 }, (_, i) => {
    const a = (i / 24) * Math.PI * 2;
    const x = 60 + Math.cos(a) * 56;
    const y = 60 + Math.sin(a) * 56;
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6" fill="${c}"/>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">
    ${teeth}<circle cx="60" cy="60" r="54" fill="${c}"/>
    <circle cx="60" cy="60" r="46" fill="none" stroke="#fff" stroke-width="1.5" stroke-dasharray="2 3"/>
    <circle cx="60" cy="60" r="38" fill="#fff"/>
    <text x="60" y="48" text-anchor="middle" font-family="Georgia, serif" font-size="9" font-weight="700" fill="${c}" letter-spacing="1.5">WARRANTY</text>
    <path d="M46 61 l9 9 l19 -19" fill="none" stroke="${c}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="60" y="86" text-anchor="middle" font-family="Georgia, serif" font-size="8" font-weight="700" fill="${c}" letter-spacing="1.5">CERTIFIED</text>
  </svg>`;
  // URL-encoded, not base64: this module also runs in the editor (the browser), which has no Buffer.
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg.replace(/\s+/g, " "))}`;
}

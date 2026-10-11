/**
 * HTML for the content blocks: details grid (also the specification sheet and
 * banking details), payment schedule, comparison table, callout, photo gallery
 * and QR code. Called from serialize.ts blockHtml — and, through it, by the
 * editor page — so the block designed is the block printed.
 *
 * Same rules as serialize.ts: every text value through esc(), every colour
 * through cssColor(), pictures only from the private store, a data: image or
 * https. No scripts, no outside fonts or icon sets.
 */
import QRCode from "qrcode";
import { cssColor } from "./css";
import type { CalloutBlock, ComparisonBlock, ContentBlock, DetailsGridBlock, GalleryBlock, PaymentScheduleBlock, QrBlock } from "./model";
import type { RenderCtx } from "./serialize";
import { storedFileSrc } from "@/lib/storedFileSrc";
import { DEFAULT_REGIONAL, formatZAR } from "@/lib/format";

const KEEP_BG = "-webkit-print-color-adjust:exact;print-color-adjust:exact;";
const LABEL = "font-size:7.5pt;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:#64748b";

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
/**
 * {{tokens}} against the record. Bound to a real record, an unresolved token
 * becomes EMPTY — a customer must never read "{{…}}". Unbound (the editor, a
 * template preview), it stays visible so the designer sees what fills in where.
 */
function tok(s: string, ctx: RenderCtx): string {
  return (s ?? "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k: string) => ctx?.tokens?.[k] ?? (ctx?.bound ? "" : `{{${k}}}`));
}
const text = (s: string, ctx: RenderCtx) => esc(tok(s, ctx)).replace(/\n/g, "<br/>");
const between = (n: unknown, min: number, max: number, fallback: number) => Math.min(max, Math.max(min, Math.round(Number(n)) || fallback));
const title = (s: string, ctx: RenderCtx, color = "#64748b") => (s.trim() ? `<div style="${LABEL};color:${color};margin-bottom:6px">${text(s, ctx)}</div>` : "");

// ── details grid ────────────────────────────────────────────────────
function detailsGridHtml(b: DetailsGridBlock, ctx: RenderCtx): string {
  const columns = between(b.columns, 1, 4, 2);
  // Bound to a record, a line whose value came out empty is left out — "Reg number:" with nothing after it reads as a mistake.
  const items = b.items.filter((it) => !ctx?.bound || tok(it.value, ctx).trim() || !it.label.trim());
  const cell = (it: DetailsGridBlock["items"][number]) => b.layout === "inline"
    ? `<div style="display:flex;justify-content:space-between;gap:12px;padding:4px 0;border-bottom:.5px solid #e2e8f0;break-inside:avoid"><span style="font-size:9pt;color:#64748b">${text(it.label, ctx)}</span><span style="font-size:9.5pt;font-weight:600;color:#0f172a;text-align:right">${text(it.value, ctx)}</span></div>`
    : `<div style="break-inside:avoid"><div style="${LABEL}">${text(it.label, ctx)}</div><div style="font-size:10pt;font-weight:600;color:#0f172a;margin-top:1px">${text(it.value, ctx)}</div></div>`;
  const grid = `<div style="display:grid;grid-template-columns:repeat(${columns},minmax(0,1fr));gap:${b.layout === "inline" ? "0 24px" : "10px 18px"}">${items.map(cell).join("")}</div>`;
  const inner = `${title(b.title, ctx, cssColor(b.accent, "#ea580c"))}${grid}`;
  return b.boxed
    ? `<div style="background:#f8fafc;border-radius:6px;padding:12px 14px;margin:4px 0;${KEEP_BG}">${inner}</div>`
    : `<div style="margin:4px 0">${inner}</div>`;
}

// ── payment schedule ────────────────────────────────────────────────
/**
 * The amount for each row that states a share of the total, in cents.
 *
 * Worked out in cents and made to ADD UP: when the shares come to exactly 100%,
 * the last one takes whatever rounding left over, so the schedule's amounts sum
 * to the document's total and not to a cent either side of it. A row with no
 * share (a typed amount) is null.
 */
export function scheduleAmounts(rows: { percent?: number }[], totalCents: number): (number | null)[] {
  const shares = rows.map((r) => (typeof r.percent === "number" && Number.isFinite(r.percent) && r.percent > 0 ? r.percent : null));
  const amounts = shares.map((p) => (p === null ? null : Math.round((totalCents * p) / 100)));
  const stated = shares.filter((p): p is number => p !== null);
  if (stated.length && Math.abs(stated.reduce((a, b) => a + b, 0) - 100) < 1e-9) {
    const last = shares.lastIndexOf(stated[stated.length - 1]);
    const others = amounts.reduce<number>((sum, a, i) => (i === last || a === null ? sum : sum + a), 0);
    amounts[last] = totalCents - others;
  }
  return amounts;
}

/** The document's total in cents, when it is bound to a quote or a job card. */
function documentTotalCents(ctx: RenderCtx): number | null {
  if (!ctx?.bound) return null;
  const vars = ctx.vars as { quotation?: { total?: unknown }; jobcard?: { total?: unknown } };
  const total = Number(vars.quotation?.total ?? vars.jobcard?.total);
  return Number.isFinite(total) ? Math.round(total * 100) : null;
}

function paymentScheduleHtml(b: PaymentScheduleBlock, ctx: RenderCtx): string {
  const total = documentTotalCents(ctx);
  const amounts = total === null ? b.rows.map(() => null) : scheduleAmounts(b.rows, total);
  const accent = cssColor(b.accent, "#ea580c");
  const rows = b.rows.map((r, i) => {
    const share = typeof r.percent === "number" && r.percent > 0 ? `${r.percent}%` : "";
    // A share of the total once there is a total; before that (the editor) the share itself. A typed amount is shown as typed.
    const amount = amounts[i] !== null ? esc(formatZAR(amounts[i] as number, ctx?.regional ?? DEFAULT_REGIONAL)) : share ? `${share} of the total` : text(r.amount, ctx);
    return `<tr style="break-inside:avoid">
      <td style="padding:7px 0;border-bottom:.5px solid #e2e8f0;width:22px;vertical-align:top"><span style="display:inline-block;width:16px;height:16px;border-radius:50%;background:${accent};color:#fff;font-size:7.5pt;font-weight:700;text-align:center;line-height:16px;${KEEP_BG}">${i + 1}</span></td>
      <td style="padding:7px 8px;border-bottom:.5px solid #e2e8f0"><div style="font-size:10pt;font-weight:600;color:#0f172a">${text(r.label, ctx)}${share && amounts[i] !== null ? ` <span style="font-weight:400;color:#64748b">(${share})</span>` : ""}</div>${r.due.trim() ? `<div style="font-size:8.5pt;color:#64748b">${text(r.due, ctx)}</div>` : ""}</td>
      <td style="padding:7px 0;border-bottom:.5px solid #e2e8f0;text-align:right;font-size:10pt;font-weight:700;color:#0f172a;white-space:nowrap;vertical-align:top">${amount}</td>
    </tr>`;
  }).join("");
  return `<div style="margin:4px 0">${title(b.title, ctx)}<table style="width:100%;border-collapse:collapse"><tbody>${rows}</tbody></table></div>`;
}

// ── comparison ──────────────────────────────────────────────────────
const YES = /^(yes|y|true|✓|✔|included)$/i;
const NO = /^(no|n|false|✗|✘|x|-|—|not included)$/i;

function comparisonHtml(b: ComparisonBlock, ctx: RenderCtx): string {
  const accent = cssColor(b.accent, "#ea580c");
  const options = b.options.slice(0, 5);
  const tint = `background:${accent}14;${KEEP_BG}`; // the accent at 8% — an allow-listed colour plus two hex digits
  const hex = /^#[0-9a-f]{6}$/i.test(accent);
  const mark = (on: boolean) => (on ? tint : "");
  const value = (raw: string) => {
    const v = tok(raw ?? "", ctx).trim();
    if (YES.test(v)) return `<span style="color:#16a34a;font-weight:700">✓</span>`;
    if (NO.test(v)) return `<span style="color:#cbd5e1">—</span>`;
    return esc(v);
  };
  const head = `<tr><th style="padding:8px 8px;text-align:left"></th>${options.map((o) => `<th style="padding:8px 8px;text-align:center;font-size:9.5pt;font-weight:700;color:${o.highlight ? accent : "#0f172a"};border-bottom:2px solid ${o.highlight ? accent : "#e2e8f0"};${mark(o.highlight && hex)}">${text(o.name, ctx)}</th>`).join("")}</tr>`;
  const body = b.rows.map((r) => `<tr style="break-inside:avoid"><td style="padding:6px 8px;border-bottom:.5px solid #e2e8f0;font-size:9.5pt;color:#334155">${text(r.label, ctx)}</td>${options.map((o, i) => `<td style="padding:6px 8px;border-bottom:.5px solid #e2e8f0;text-align:center;font-size:9.5pt;color:#0f172a;${mark(o.highlight && hex)}">${value(r.cells[i] ?? "")}</td>`).join("")}</tr>`).join("");
  return `<table style="width:100%;border-collapse:collapse;margin:6px 0"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

// ── callout ─────────────────────────────────────────────────────────
const TONES = {
  info: { edge: "#2563eb", fill: "#eff6ff", ink: "#1e3a8a" },
  success: { edge: "#16a34a", fill: "#f0fdf4", ink: "#14532d" },
  warning: { edge: "#d97706", fill: "#fffbeb", ink: "#78350f" },
} as const;

function calloutHtml(b: CalloutBlock, ctx: RenderCtx): string {
  const accent = cssColor(b.accent, "#ea580c");
  const tone = b.tone === "accent" ? { edge: accent, fill: "#f8fafc", ink: "#0f172a" } : TONES[b.tone] ?? TONES.info;
  return `<div style="background:${tone.fill};border-left:3px solid ${tone.edge};border-radius:6px;padding:10px 14px;margin:4px 0;break-inside:avoid;${KEEP_BG}">${b.title.trim() ? `<div style="font-size:10pt;font-weight:700;color:${tone.ink};margin-bottom:2px">${text(b.title, ctx)}</div>` : ""}<div style="font-size:9.5pt;line-height:1.45;color:${tone.ink}">${text(b.text, ctx)}</div></div>`;
}

// ── gallery ─────────────────────────────────────────────────────────
/** The picture's address as the page may load it — or "" for anything that is not a stored upload, an inline image or https. */
export function pictureSrc(raw: string, ctx: RenderCtx): string {
  const value = tok(String(raw ?? ""), ctx).trim();
  const src = /^data:image\//i.test(value) ? value : storedFileSrc(value);
  return src && /^(https:|data:image\/|\/api\/stored\?)/i.test(src) ? src : "";
}

function galleryHtml(b: GalleryBlock, ctx: RenderCtx): string {
  const columns = between(b.columns, 1, 6, 3);
  const gap = between(b.gap, 0, 32, 8);
  const [w, h] = b.aspect.split(":").map(Number);
  const cells = b.images.map((img) => {
    const src = pictureSrc(img.src, ctx);
    const frame = `width:100%;aspect-ratio:${w} / ${h};border-radius:${b.rounded ? 6 : 0}px;display:block`;
    // Bound to a record, a picture that cannot be shown is left out; in the editor its place is drawn.
    if (!src) return ctx?.bound ? "" : `<div><div style="${frame};background:#f1f5f9;border:1px dashed #cbd5e1"></div></div>`;
    return `<div style="break-inside:avoid"><img src="${esc(src)}" alt="${esc(img.alt)}" style="${frame};object-fit:cover"/>${img.caption.trim() ? `<div style="font-size:8pt;color:#64748b;margin-top:3px;line-height:1.3">${text(img.caption, ctx)}</div>` : ""}</div>`;
  }).join("");
  return `<div style="display:grid;grid-template-columns:repeat(${columns},minmax(0,1fr));gap:${gap}px;margin:6px 0">${cells}</div>`;
}

// ── QR code ─────────────────────────────────────────────────────────
/** An SVG QR code for a web address, drawn here — no image is fetched from anywhere. "" when it cannot be encoded. */
export function qrSvg(url: string, size: number): string {
  try {
    const { modules } = QRCode.create(url, { errorCorrectionLevel: "M" });
    const n = modules.size, quiet = 2;
    let path = "";
    for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) if (modules.data[row * n + col]) path += `M${col + quiet} ${row + quiet}h1v1h-1z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${n + quiet * 2} ${n + quiet * 2}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
  } catch {
    return "";
  }
}

function qrHtml(b: QrBlock, ctx: RenderCtx): string {
  const size = between(b.size, 48, 240, 96);
  const url = tok(b.url, ctx).trim();
  // Only a real web address becomes a code: a customer scans it, so it must go where it says.
  const ok = /^https?:\/\/[^\s<>"']{3,}$/i.test(url) && url.length <= 600;
  const code = ok ? qrSvg(url, size) : "";
  // Nothing to scan: nothing for a customer; in the editor, the place it will go.
  if (!code && ctx?.bound) return "";
  const box = code || `<div style="width:${size}px;height:${size}px;border:1px dashed #cbd5e1;border-radius:4px;display:flex;align-items:center;justify-content:center;text-align:center;font-size:7.5pt;color:#94a3b8;padding:4px">${url ? "QR code — fills in from the record" : "Add a link"}</div>`;
  const words = `${b.label.trim() ? `<div style="font-size:10pt;font-weight:700;color:#0f172a">${text(b.label, ctx)}</div>` : ""}${b.caption.trim() ? `<div style="font-size:9pt;color:#64748b;margin-top:2px">${text(b.caption, ctx)}</div>` : ""}${b.showUrl && url ? `<div style="font-size:8pt;color:#2563eb;margin-top:3px;word-break:break-all">${esc(url)}</div>` : ""}`;
  return `<div style="display:flex;align-items:center;gap:12px;margin:4px 0;break-inside:avoid"><div style="flex:none;line-height:0">${box}</div>${words ? `<div style="min-width:0">${words}</div>` : ""}</div>`;
}

export function contentBlockHtml(block: ContentBlock, ctx: RenderCtx): string {
  switch (block.type) {
    case "detailsGrid": return detailsGridHtml(block, ctx);
    case "paymentSchedule": return paymentScheduleHtml(block, ctx);
    case "comparison": return comparisonHtml(block, ctx);
    case "callout": return calloutHtml(block, ctx);
    case "gallery": return galleryHtml(block, ctx);
    case "qr": return qrHtml(block, ctx);
  }
}

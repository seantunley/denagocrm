/**
 * The "Handover checklist" block: the delivery checklist runs a customer signs
 * beside, plus the signature they gave. Pure (no server imports) so the print
 * serializer, the editor canvas and the tests share one renderer.
 *
 * The data is gathered by the delivery note's context builder and handed in on
 * `ctx.vars.handover`; this file only draws it. Without it (no linked record, or
 * a document that is not a delivery note) the block shows a sample, the same way
 * the line-items block does.
 */

export type HandoverEntry = {
  label: string;
  mark: "done" | "skipped" | "open";
  detail: string | null;
  /** data: or https: image sources — already embedded by the server. */
  photos: string[];
};

export type HandoverRun = {
  /** Null for the legacy (pre-guided) checklist, which has no template name. */
  name: string | null;
  completed: string | null;
  entries: HandoverEntry[];
};

export type HandoverData = {
  runs: HandoverRun[];
  signature: string | null;
  signedOn: string | null;
};

type GuidedEntry = {
  captureSnapshot: string;
  status: string;
  note: string | null;
  value: string | null;
  skipReason: string | null;
  photos: ReadonlyArray<unknown>;
};

/** The one-line detail under a guided checklist entry. Shared with the legacy print page. */
export function guidedEntryDetail(entry: GuidedEntry): string | null {
  if (entry.status === "skipped" || entry.status === "na") {
    return entry.skipReason ? `Skipped — ${entry.skipReason}` : "Skipped";
  }
  if (entry.captureSnapshot === "boolean") {
    if (entry.value === "true") return "Yes";
    if (entry.value === "false") return "No";
  }
  if (entry.captureSnapshot === "text" || entry.captureSnapshot === "number") {
    return entry.value?.trim() || null;
  }
  if (entry.captureSnapshot === "photo" || entry.captureSnapshot === "photo_note") {
    const evidence = `${entry.photos.length} photo${entry.photos.length === 1 ? "" : "s"}`;
    return entry.note?.trim() ? `${evidence} · ${entry.note.trim()}` : evidence;
  }
  return entry.note?.trim() || entry.value?.trim() || null;
}

/** What the delivery note printed before guided checklists existed, when nothing was ticked. */
export const DEFAULT_HANDOVER_ITEMS = [
  "Battery fully charged",
  "Charger & cable handed over",
  "Keys handed over",
  "Owner's manual provided",
  "Controls & safety walkthrough done",
  "Cart inspected — no visible damage",
];

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Only an embedded image or an https link may reach an <img src>. */
function safeImage(src: unknown): string | null {
  const s = typeof src === "string" ? src.trim() : "";
  return /^(https:|data:image\/(png|jpe?g|gif|webp);)/i.test(s) ? s : null;
}

const SAMPLE: HandoverData = {
  runs: [{ name: null, completed: null, entries: DEFAULT_HANDOVER_ITEMS.map((label) => ({ label, mark: "open", detail: null, photos: [] })) }],
  signature: null,
  signedOn: null,
};

function readHandover(ctx: { vars?: Record<string, unknown>; bound?: boolean } | null): HandoverData {
  const h = ctx?.bound ? (ctx.vars?.handover as HandoverData | undefined) : undefined;
  return h && Array.isArray(h.runs) ? h : SAMPLE;
}

function entryHtml(e: HandoverEntry): string {
  const mark = e.mark === "done" ? "✓" : e.mark === "skipped" ? "—" : "";
  const photos = (e.photos ?? []).map(safeImage).filter((s): s is string => !!s);
  return `<div style="display:flex;align-items:flex-start;gap:8px;font-size:9pt;color:#334155;break-inside:avoid">
    <span style="flex:none;display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;margin-top:2px;border:1px solid #94a3b8;border-radius:3px;font-size:7.5pt;line-height:1">${mark}</span>
    <span style="min-width:0"><span>${esc(e.label)}</span>${e.detail ? `<span style="display:block;font-size:7.5pt;color:#64748b">${esc(e.detail)}</span>` : ""}${photos.length ? `<span style="display:flex;flex-wrap:wrap;gap:4px;margin-top:3px">${photos.map((p) => `<img src="${esc(p)}" alt="" style="height:56px;width:auto;border-radius:3px;border:1px solid #e2e8f0"/>`).join("")}</span>` : ""}</span>
  </div>`;
}

function runHtml(run: HandoverRun): string {
  const head = run.name
    ? `<div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:6px"><div style="font-size:9pt;font-weight:600;color:#1e293b">${esc(run.name)}</div>${run.completed ? `<div style="font-size:7.5pt;color:#64748b">Completed ${esc(run.completed)}</div>` : ""}</div>`
    : "";
  return `<div>${head}<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 24px">${run.entries.map(entryHtml).join("")}</div></div>`;
}

/** Print HTML for the block. `ctx` is the serializer's RenderCtx. */
export function handoverChecklistHtml(ctx: { vars?: Record<string, unknown>; bound?: boolean } | null): string {
  const h = readHandover(ctx);
  const checklist = `<div style="background:#f8fafc;border-radius:8px;padding:12px 16px;margin:6px 0;break-inside:avoid">
    <div style="font-size:8pt;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#64748b;margin-bottom:8px">Handover checklist</div>
    <div style="display:flex;flex-direction:column;gap:14px">${h.runs.map(runHtml).join("")}</div>
  </div>`;
  const sig = safeImage(h.signature);
  const signature = sig
    ? `<div style="border:1px solid #e2e8f0;border-radius:8px;padding:12px 16px;margin:12px 0 6px;break-inside:avoid">
    <div style="font-size:8pt;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#64748b;margin-bottom:8px">Customer signature</div>
    <img src="${esc(sig)}" alt="Customer signature" style="height:80px;max-width:100%;object-fit:contain;object-position:left"/>
    ${h.signedOn ? `<div style="margin-top:4px;font-size:7.5pt;color:#64748b">Recorded on ${esc(h.signedOn)}</div>` : ""}
  </div>`
    : "";
  return checklist + signature;
}

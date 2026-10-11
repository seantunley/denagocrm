"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useEditor } from "@/lib/doceditor/store";
import type { CalloutBlock, ComparisonBlock, ContentBlock, DetailsGridBlock, DocumentBlock, GalleryBlock, PaymentScheduleBlock, QrBlock } from "@/lib/doceditor/model";
import { uploadDocEditorImage } from "@/app/actions/doceditor";
import { checkDocImage, DOC_IMAGE_ACCEPT } from "@/lib/doceditor/imageUpload";
import { storedFileSrc } from "@/lib/storedFileSrc";
import { useDocEditorEnv } from "./EditorContext";

const lbl = "block text-[11px] font-medium text-slate-500 mb-1";
const inp = "w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-800 focus:border-orange-400 focus:outline-none";
const row = "mb-3";
const add = "w-full rounded-md border border-dashed border-slate-300 py-1.5 text-sm text-slate-500 hover:border-orange-300 hover:text-orange-600";
const small = "rounded px-1 text-xs text-slate-400 hover:text-slate-700 disabled:opacity-30";
const HINT = "Text here takes merge fields — type {{customer.name}}, {{quote.total}} and so on.";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-slate-100 p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</div>
      {children}
    </div>
  );
}

/** Move / remove for one entry of a list. */
function ItemTools({ index, count, what, onMove, onRemove }: { index: number; count: number; what: string; onMove: (by: -1 | 1) => void; onRemove: () => void }) {
  return (
    <span className="flex shrink-0 items-center">
      <button type="button" className={small} title="Move up" aria-label={`Move ${what} ${index + 1} up`} disabled={index === 0} onClick={() => onMove(-1)}>▲</button>
      <button type="button" className={small} title="Move down" aria-label={`Move ${what} ${index + 1} down`} disabled={index === count - 1} onClick={() => onMove(1)}>▼</button>
      <button type="button" className="rounded px-1 text-xs text-red-500 hover:bg-red-50" title="Remove" aria-label={`Remove ${what} ${index + 1}`} onClick={onRemove}>✕</button>
    </span>
  );
}
const moved = <T,>(list: T[], i: number, by: -1 | 1): T[] => { const next = [...list]; [next[i], next[i + by]] = [next[i + by], next[i]]; return next; };
const replaced = <T,>(list: T[], i: number, patch: Partial<T>): T[] => list.map((x, j) => (j === i ? { ...x, ...patch } : x));

function useSet<B extends ContentBlock>(block: B) {
  const updateBlock = useEditor((s) => s.updateBlock);
  return (patch: Partial<B>) => updateBlock(block.id, patch as Partial<DocumentBlock>);
}

function Accent({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <div className={row}><label className={lbl}>Accent colour</label><input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="h-8 w-full rounded border border-slate-300" /></div>;
}

function DetailsGridProps({ block }: { block: DetailsGridBlock }) {
  const set = useSet(block);
  return (
    <Section title="Details grid">
      <div className={row}><label className={lbl}>Heading (optional)</label><input className={inp} value={block.title} onChange={(e) => set({ title: e.target.value })} /></div>
      <div className="mb-3 grid grid-cols-2 gap-2">
        <div><label className={lbl}>Columns</label>
          <select className={inp} value={block.columns} onChange={(e) => set({ columns: Number(e.target.value) })}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</select>
        </div>
        <div><label className={lbl}>Label goes</label>
          <select className={inp} value={block.layout} onChange={(e) => set({ layout: e.target.value as DetailsGridBlock["layout"] })}><option value="stacked">Above its value</option><option value="inline">Beside its value</option></select>
        </div>
      </div>
      <label className="mb-3 flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={block.boxed} onChange={(e) => set({ boxed: e.target.checked })} /> In a shaded box</label>
      <Accent value={block.accent} onChange={(accent) => set({ accent })} />
      <label className={lbl}>Lines</label>
      <div className="space-y-1.5">
        {block.items.map((it, i) => (
          <div key={i} className="flex items-center gap-1">
            <input className={inp} aria-label={`Label ${i + 1}`} placeholder="Label" value={it.label} onChange={(e) => set({ items: replaced(block.items, i, { label: e.target.value }) })} />
            <input className={inp} aria-label={`Value ${i + 1}`} placeholder="Value" value={it.value} onChange={(e) => set({ items: replaced(block.items, i, { value: e.target.value }) })} />
            <ItemTools index={i} count={block.items.length} what="line" onMove={(by) => set({ items: moved(block.items, i, by) })} onRemove={() => set({ items: block.items.filter((_, j) => j !== i) })} />
          </div>
        ))}
        <button type="button" className={add} onClick={() => set({ items: [...block.items, { label: "", value: "" }] })}>＋ Add a line</button>
      </div>
      <p className="mt-2 text-[11px] text-slate-400">{HINT} On a real document, a line whose value comes out empty is left out.</p>
    </Section>
  );
}

function PaymentScheduleProps({ block }: { block: PaymentScheduleBlock }) {
  const set = useSet(block);
  const shares = block.rows.reduce((sum, r) => sum + (r.percent ?? 0), 0);
  return (
    <Section title="Payment schedule">
      <div className={row}><label className={lbl}>Heading</label><input className={inp} value={block.title} onChange={(e) => set({ title: e.target.value })} /></div>
      <Accent value={block.accent} onChange={(accent) => set({ accent })} />
      <div className="space-y-2">
        {block.rows.map((r, i) => (
          <div key={i} className="rounded-md border border-slate-200 p-2">
            <div className="mb-1 flex items-center gap-1">
              <input className={inp} aria-label={`Payment ${i + 1}`} placeholder="e.g. Deposit" value={r.label} onChange={(e) => set({ rows: replaced(block.rows, i, { label: e.target.value }) })} />
              <ItemTools index={i} count={block.rows.length} what="payment" onMove={(by) => set({ rows: moved(block.rows, i, by) })} onRemove={() => set({ rows: block.rows.filter((_, j) => j !== i) })} />
            </div>
            <input className={`${inp} mb-1`} aria-label={`When payment ${i + 1} is due`} placeholder="When it is due — e.g. On acceptance" value={r.due} onChange={(e) => set({ rows: replaced(block.rows, i, { due: e.target.value }) })} />
            <div className="flex items-center gap-1">
              <input
                type="number" min={0} max={100} step={5} className="w-20 rounded-md border border-slate-300 px-2 py-1.5 text-sm" aria-label={`Share of the total for payment ${i + 1}, percent`} placeholder="%"
                value={r.percent ?? ""}
                onChange={(e) => { const n = Number(e.target.value); const { percent: _p, ...rest } = r; void _p; set({ rows: block.rows.map((x, j) => (j === i ? (e.target.value && n > 0 ? { ...rest, percent: Math.min(100, n) } : rest) : x)) }); }}
              />
              <span className="text-xs text-slate-500">% of the total, or</span>
              <input className={inp} aria-label={`Amount for payment ${i + 1}`} placeholder="a typed amount" disabled={!!r.percent} value={r.percent ? "" : r.amount} onChange={(e) => set({ rows: replaced(block.rows, i, { amount: e.target.value }) })} />
            </div>
          </div>
        ))}
        <button type="button" className={add} onClick={() => set({ rows: [...block.rows, { label: "", due: "", amount: "" }] })}>＋ Add a payment</button>
      </div>
      <p className={`mt-2 text-[11px] ${shares > 0 && shares !== 100 ? "text-amber-600" : "text-slate-400"}`}>
        {shares > 0 && shares !== 100 ? `The shares add up to ${shares}%, not 100%. ` : ""}A share is worked out from the quote&apos;s or job card&apos;s total when the document is made — to the cent, so the payments add up to the total.
      </p>
    </Section>
  );
}

function ComparisonProps({ block }: { block: ComparisonBlock }) {
  const set = useSet(block);
  const options = block.options;
  return (
    <Section title="Comparison">
      <Accent value={block.accent} onChange={(accent) => set({ accent })} />
      <label className={lbl}>Options (columns)</label>
      <div className="mb-3 space-y-1.5">
        {options.map((o, i) => (
          <div key={i} className="flex items-center gap-1">
            <input className={inp} aria-label={`Option ${i + 1}`} placeholder="Option name" value={o.name} onChange={(e) => set({ options: replaced(options, i, { name: e.target.value }) })} />
            <label className="flex shrink-0 items-center gap-1 text-[11px] text-slate-600" title="Pick this option out in the accent colour"><input type="checkbox" checked={o.highlight} onChange={(e) => set({ options: options.map((x, j) => ({ ...x, highlight: j === i ? e.target.checked : false })) })} /> Pick out</label>
            <button
              type="button" className="rounded px-1 text-xs text-red-500 hover:bg-red-50 disabled:opacity-30" title="Remove this option" aria-label={`Remove option ${i + 1}`} disabled={options.length <= 1}
              // The option goes with its cell in every row.
              onClick={() => set({ options: options.filter((_, j) => j !== i), rows: block.rows.map((r) => ({ ...r, cells: r.cells.filter((_, j) => j !== i) })) })}
            >✕</button>
          </div>
        ))}
        <button type="button" className={add} disabled={options.length >= 5} onClick={() => set({ options: [...options, { name: "", highlight: false }] })}>＋ Add an option</button>
      </div>
      <label className={lbl}>Rows</label>
      <div className="space-y-2">
        {block.rows.map((r, i) => (
          <div key={i} className="rounded-md border border-slate-200 p-2">
            <div className="mb-1 flex items-center gap-1">
              <input className={inp} aria-label={`Row ${i + 1}`} placeholder="What is compared" value={r.label} onChange={(e) => set({ rows: replaced(block.rows, i, { label: e.target.value }) })} />
              <ItemTools index={i} count={block.rows.length} what="row" onMove={(by) => set({ rows: moved(block.rows, i, by) })} onRemove={() => set({ rows: block.rows.filter((_, j) => j !== i) })} />
            </div>
            <div className="flex gap-1">
              {options.map((o, oi) => (
                <input key={oi} className={inp} aria-label={`Row ${i + 1}, ${o.name || `option ${oi + 1}`}`} placeholder={o.name || `Option ${oi + 1}`} value={r.cells[oi] ?? ""} onChange={(e) => set({ rows: replaced(block.rows, i, { cells: options.map((_, j) => (j === oi ? e.target.value : r.cells[j] ?? "")) }) })} />
              ))}
            </div>
          </div>
        ))}
        <button type="button" className={add} onClick={() => set({ rows: [...block.rows, { label: "", cells: options.map(() => "") }] })}>＋ Add a row</button>
      </div>
      <p className="mt-2 text-[11px] text-slate-400">Type <b>yes</b> or <b>no</b> in a cell for a tick or a dash. Up to five options.</p>
    </Section>
  );
}

function CalloutProps({ block }: { block: CalloutBlock }) {
  const set = useSet(block);
  return (
    <Section title="Callout">
      <div className={row}><label className={lbl}>Kind</label>
        <select className={inp} value={block.tone} onChange={(e) => set({ tone: e.target.value as CalloutBlock["tone"] })}>
          <option value="info">Information (blue)</option><option value="success">Good news (green)</option><option value="warning">Take care (amber)</option><option value="accent">Your accent colour</option>
        </select>
      </div>
      {block.tone === "accent" && <Accent value={block.accent} onChange={(accent) => set({ accent })} />}
      <div className={row}><label className={lbl}>Heading (optional)</label><input className={inp} value={block.title} onChange={(e) => set({ title: e.target.value })} /></div>
      <div className={row}><label className={lbl}>Text</label><textarea className={inp} rows={4} value={block.text} onChange={(e) => set({ text: e.target.value })} /></div>
      <p className="text-[11px] text-slate-400">{HINT}</p>
    </Section>
  );
}

function GalleryProps({ block }: { block: GalleryBlock }) {
  const set = useSet(block);
  const { templateId } = useDocEditorEnv();
  const [busy, setBusy] = useState<number | null>(null);
  // The same checked upload the image block uses: typed from its bytes, filed under this template's workspace.
  const upload = async (i: number, file: File) => {
    const check = checkDocImage(file.size, new Uint8Array(await file.slice(0, 16).arrayBuffer()));
    if (!check.ok) { toast.error(check.error); return; }
    setBusy(i);
    try {
      const form = new FormData();
      form.set("file", file);
      if (templateId) form.set("templateId", templateId);
      const result = await uploadDocEditorImage(form);
      if (result.ok) set({ images: replaced(block.images, i, { src: result.ref }) });
      else toast.error(result.error);
    } catch {
      toast.error("The upload failed. Try again.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <Section title="Photo gallery">
      <div className="mb-3 grid grid-cols-2 gap-2">
        <div><label className={lbl}>Across</label>
          <select className={inp} value={block.columns} onChange={(e) => set({ columns: Number(e.target.value) })}>{[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}</select>
        </div>
        <div><label className={lbl}>Shape</label>
          <select className={inp} value={block.aspect} onChange={(e) => set({ aspect: e.target.value as GalleryBlock["aspect"] })}>
            <option value="1:1">Square</option><option value="4:3">Landscape 4:3</option><option value="3:2">Landscape 3:2</option><option value="16:9">Wide 16:9</option><option value="3:4">Portrait 3:4</option>
          </select>
        </div>
      </div>
      <div className={row}><label className={lbl}>Gap ({block.gap}px)</label><input type="range" min={0} max={32} className="w-full" value={block.gap} onChange={(e) => set({ gap: Number(e.target.value) })} /></div>
      <label className="mb-3 flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={block.rounded} onChange={(e) => set({ rounded: e.target.checked })} /> Rounded corners</label>
      <label className={lbl}>Pictures</label>
      <div className="space-y-2">
        {block.images.map((img, i) => {
          const uploaded = !!img.src && storedFileSrc(img.src) !== img.src;
          return (
            <div key={i} className="rounded-md border border-slate-200 p-2">
              <div className="mb-1 flex items-center gap-1">
                <label className={`flex flex-1 cursor-pointer items-center justify-center rounded-md border border-slate-300 py-1 text-xs text-slate-700 hover:bg-slate-50 ${busy === i ? "pointer-events-none opacity-60" : ""}`}>
                  {busy === i ? "Uploading…" : uploaded ? "Replace picture" : img.src ? "Upload instead" : "Upload picture"}
                  <input type="file" accept={DOC_IMAGE_ACCEPT} className="sr-only" disabled={busy !== null} onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void upload(i, file); }} />
                </label>
                <ItemTools index={i} count={block.images.length} what="picture" onMove={(by) => set({ images: moved(block.images, i, by) })} onRemove={() => set({ images: block.images.filter((_, j) => j !== i) })} />
              </div>
              <input className={`${inp} mb-1`} aria-label={`Link for picture ${i + 1}`} placeholder={uploaded ? "Uploaded — paste an https link to replace it" : "…or an https:// link"} value={uploaded ? "" : img.src} onChange={(e) => set({ images: replaced(block.images, i, { src: e.target.value }) })} />
              <input className={inp} aria-label={`Caption for picture ${i + 1}`} placeholder="Caption (optional)" value={img.caption} onChange={(e) => set({ images: replaced(block.images, i, { caption: e.target.value, alt: img.alt || e.target.value }) })} />
            </div>
          );
        })}
        <button type="button" className={add} disabled={block.images.length >= 24} onClick={() => set({ images: [...block.images, { src: "", alt: "", caption: "" }] })}>＋ Add a picture</button>
      </div>
      <p className="mt-2 text-[11px] text-slate-400">PNG, JPEG or WebP, up to 5 MB each. Every picture is cropped to the one shape, from its centre.</p>
    </Section>
  );
}

function QrProps({ block }: { block: QrBlock }) {
  const set = useSet(block);
  const literal = block.url.trim() && !block.url.includes("{{");
  const bad = literal && !/^https?:\/\/\S{3,}$/i.test(block.url.trim());
  return (
    <Section title="QR code">
      <div className={row}>
        <label className={lbl}>Link the code opens</label>
        <input className={`${inp} ${bad ? "border-red-400" : ""}`} value={block.url} placeholder="https://… or {{company.website}}" onChange={(e) => set({ url: e.target.value })} />
        {bad ? <p className="mt-1 text-[11px] text-red-600">A link starts with https:// (or http://). Nothing is printed until it does.</p> : null}
      </div>
      <div className={row}><label className={lbl}>Heading beside it</label><input className={inp} value={block.label} onChange={(e) => set({ label: e.target.value })} /></div>
      <div className={row}><label className={lbl}>Line under the heading</label><input className={inp} value={block.caption} onChange={(e) => set({ caption: e.target.value })} /></div>
      <div className={row}><label className={lbl}>Size ({block.size}px)</label><input type="range" min={48} max={240} step={8} className="w-full" value={block.size} onChange={(e) => set({ size: Number(e.target.value) })} /></div>
      <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={block.showUrl} onChange={(e) => set({ showUrl: e.target.checked })} /> Print the link in words too</label>
      <p className="mt-2 text-[11px] text-slate-400">The code is drawn into the document itself — nothing is fetched from another site. Printing the link too lets someone type it if they cannot scan.</p>
    </Section>
  );
}

/** The panel for a details grid, payment schedule, comparison, callout, gallery or QR code. */
export function ContentBlockProps({ block }: { block: ContentBlock }) {
  switch (block.type) {
    case "detailsGrid": return <DetailsGridProps block={block} />;
    case "paymentSchedule": return <PaymentScheduleProps block={block} />;
    case "comparison": return <ComparisonProps block={block} />;
    case "callout": return <CalloutProps block={block} />;
    case "gallery": return <GalleryProps block={block} />;
    case "qr": return <QrProps block={block} />;
  }
}

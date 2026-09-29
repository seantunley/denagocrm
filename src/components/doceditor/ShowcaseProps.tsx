"use client";

import { useEditor } from "@/lib/doceditor/store";
import { showcaseIconNames, type ShowcaseBlock, type ShowcaseIcon } from "@/lib/doceditor/model";
import { toast } from "sonner";

const lbl = "block text-[11px] font-medium text-slate-500 mb-1";
const inp = "w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-800 focus:border-orange-400 focus:outline-none";
const hint = "mt-1 text-[11px] leading-4 text-slate-500";
/** The band photo is stored inline in the template (and every signed snapshot), so keep it small. */
const MAX_BAND_IMAGE_BYTES = 600 * 1024;

function Field({ label, value, onChange, multiline }: { label: string; value: string; onChange: (v: string) => void; multiline?: boolean }) {
  return (
    <div className="mb-3">
      <label className={lbl}>{label}</label>
      {multiline
        ? <textarea className={inp} rows={3} value={value} onChange={(e) => onChange(e.target.value)} />
        : <input className={inp} value={value} onChange={(e) => onChange(e.target.value)} />}
    </div>
  );
}

function Colour({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return <div><label className={lbl}>{label}</label><input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="h-8 w-full rounded border border-slate-300" /></div>;
}

/**
 * A band's optional background photo, stored inline as a data URL in the block —
 * so it is copied into every signing snapshot with the document and a signed
 * quote can never change under a later re-upload.
 */
function BandImage({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const pick = (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return void toast.error("Choose a PNG, JPG or WebP image.");
    if (file.size > MAX_BAND_IMAGE_BYTES) return void toast.error("Band images must be 600 KB or smaller — export a compressed JPG.");
    const reader = new FileReader();
    reader.onload = () => onChange(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  };
  return (
    <div className="mb-2">
      <label className={lbl}>Background photo (optional)</label>
      <input type="file" accept="image/png,image/jpeg,image/webp" className="w-full text-xs" onChange={(e) => pick(e.target.files?.[0])} />
      {value ? <button type="button" className="mt-1 text-[11px] text-red-500 underline" onClick={() => onChange("")}>Remove photo</button> : null}
      <p className={hint}>Fills the band behind a dark overlay so the text stays readable on any photo. Without one the band is a dark gradient.</p>
    </div>
  );
}

/** Properties for the showcase quotation blocks (see lib/doceditor/showcaseRender.ts). */
export function ShowcaseProps({ block }: { block: ShowcaseBlock }) {
  const updateBlock = useEditor((s) => s.updateBlock);
  const set = (patch: Record<string, unknown>) => updateBlock(block.id, patch as never);

  const wrap = (title: string, body: React.ReactNode) => (
    <div className="border-b border-slate-100 p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</div>
      {body}
    </div>
  );

  switch (block.type) {
    case "showcaseHeader": {
      return wrap("Header band", <>
        <Field label="Title" value={block.title} onChange={(title) => set({ title })} />
        <Field label="Number (supports {{quote.number}})" value={block.docNumber} onChange={(docNumber) => set({ docNumber })} />
        <Field label="Tagline" value={block.tagline} onChange={(tagline) => set({ tagline })} />
        <div className="mb-3 grid grid-cols-2 gap-2">
          <Colour label="Background" value={block.bg} onChange={(bg) => set({ bg })} />
          <Colour label="Accent" value={block.accent} onChange={(accent) => set({ accent })} />
        </div>
        <BandImage value={block.bgImage} onChange={(bgImage) => set({ bgImage })} />
        <label className="mt-2 flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={block.showLogo} onChange={(e) => set({ showLogo: e.target.checked })} /> Show logo</label>
      </>);
    }
    case "infoStrip": {
      const items = block.items;
      const setItem = (i: number, patch: Partial<(typeof items)[number]>) => set({ items: items.map((it, j) => (j === i ? { ...it, ...patch } : it)) });
      return wrap("Info strip", <>
        {items.map((it, i) => (
          <div key={i} className="mb-2 space-y-1 rounded-md border border-slate-200 p-2">
            <div className="flex gap-1">
              <select className={inp} value={it.icon} onChange={(e) => setItem(i, { icon: e.target.value as ShowcaseIcon })}>
                {showcaseIconNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <button type="button" className="px-1 text-red-500" onClick={() => set({ items: items.filter((_, j) => j !== i) })}>✕</button>
            </div>
            <input className={inp} placeholder="Label" value={it.label} onChange={(e) => setItem(i, { label: e.target.value })} />
            <input className={inp} placeholder="Value — merge fields OK" value={it.value} onChange={(e) => setItem(i, { value: e.target.value })} />
            <input className={inp} placeholder="Small line under (optional)" value={it.sub} onChange={(e) => setItem(i, { sub: e.target.value })} />
          </div>
        ))}
        {items.length < 4 && <button type="button" className="w-full rounded-md border border-dashed border-slate-300 py-1 text-xs text-slate-500 hover:border-orange-300 hover:text-orange-600" onClick={() => set({ items: [...items, { icon: "calendar", label: "LABEL", value: "", sub: "" }] })}>＋ Add item</button>}
      </>);
    }
    case "vehicleShowcase":
      return wrap("Vehicle showcase", <>
        <div className="mb-3">
          <label className={lbl}>Show</label>
          <select className={inp} value={block.part} onChange={(e) => set({ part: e.target.value })}>
            <option value="full">Details and photo side by side</option>
            <option value="details">Details only (name, tagline, description, specs)</option>
            <option value="image">Photo only</option>
          </select>
        </div>
        <Field label="Brand line" value={block.brand} onChange={(brand) => set({ brand })} />
        <div className="mb-3 grid grid-cols-2 gap-2">
          <div className="col-span-2">
            <label className={lbl}>Photo fit</label>
            <select className={inp} value={block.imageFit} onChange={(e) => set({ imageFit: e.target.value })}>
              <option value="cover">Fill the area, fade into the page (scenic photos)</option>
              <option value="contain">Show the whole photo (cut-outs on white/transparent)</option>
            </select>
          </div>
          <div><label className={lbl}>Photo height (px)</label><input type="number" min={120} max={520} className={inp} value={block.imageHeight} onChange={(e) => set({ imageHeight: Number(e.target.value) || 280 })} /></div>
          <Colour label="Accent" value={block.accent} onChange={(accent) => set({ accent })} />
        </div>
        <p className={hint}>Changes with every quote: the model is the quote&apos;s first vehicle line (else the lead&apos;s model), and its photo, tagline, description and specs come from Products → that model → Quote showcase. Missing parts are simply left out.</p>
      </>);
    case "totalsBox":
      return wrap("Totals box", <>
        {block.rows.map((r, i) => (
          <div key={i} className="mb-1 flex gap-1">
            <input className={inp} value={r.label} onChange={(e) => set({ rows: block.rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
            <input className={inp} value={r.value} onChange={(e) => set({ rows: block.rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
            <button type="button" className="px-1 text-red-500" onClick={() => set({ rows: block.rows.filter((_, j) => j !== i) })}>✕</button>
          </div>
        ))}
        <button type="button" className="mb-3 w-full rounded-md border border-dashed border-slate-300 py-1 text-xs text-slate-500 hover:border-orange-300 hover:text-orange-600" onClick={() => set({ rows: [...block.rows, { label: "Label", value: "" }] })}>＋ Add row</button>
        <Field label="Total label" value={block.totalLabel} onChange={(totalLabel) => set({ totalLabel })} />
        <Field label="Total amount" value={block.totalAmount} onChange={(totalAmount) => set({ totalAmount })} />
        <div className="grid grid-cols-2 gap-2">
          <Colour label="Bar" value={block.bg} onChange={(bg) => set({ bg })} />
          <Colour label="Amount" value={block.accent} onChange={(accent) => set({ accent })} />
        </div>
      </>);
    case "acceptance":
      return wrap("Acceptance", <>
        <Field label="Title" value={block.title} onChange={(title) => set({ title })} />
        <Field label="Confirmation text" value={block.text} onChange={(text) => set({ text })} multiline />
        <Field label="Name label" value={block.nameLabel} onChange={(nameLabel) => set({ nameLabel })} />
        <Field label="Name value" value={block.nameValue} onChange={(nameValue) => set({ nameValue })} />
        <Field label="Signature label" value={block.signatureLabel} onChange={(signatureLabel) => set({ signatureLabel })} />
        <Field label="Date label" value={block.dateLabel} onChange={(dateLabel) => set({ dateLabel })} />
        <p className={hint}>The signature and date are separate signing fields placed on these lines. If you move this card, move those two fields with it.</p>
      </>);
    case "footerBand":
      return wrap("Footer band", <>
        <Field label="Line under the company name" value={block.subtitle} onChange={(subtitle) => set({ subtitle })} />
        <div className="mb-2 grid grid-cols-2 gap-2">
          <Colour label="Background" value={block.bg} onChange={(bg) => set({ bg })} />
          <Colour label="Accent" value={block.accent} onChange={(accent) => set({ accent })} />
        </div>
        <BandImage value={block.bgImage} onChange={(bgImage) => set({ bgImage })} />
        <p className={hint}>Name, address, phone, website, email and Instagram come from Settings → Company.</p>
      </>);
  }
}

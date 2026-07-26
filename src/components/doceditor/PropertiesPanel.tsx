"use client";

import { useEditor } from "@/lib/doceditor/store";
import { getBlock } from "@/lib/doceditor/ops";
import { newPricingLine } from "@/lib/doceditor/factory";
import type { DocumentBlock, OverlayField, PricingBlock, ImageBlock, DividerBlock, SpacerBlock, ConditionalBlock, TextBlock, BannerBlock, InfoCardBlock, TotalBandBlock, TermsBlock, FooterBlock, LineItemsBlock, LineItemColumn } from "@/lib/doceditor/model";
import { lineItemColKeys } from "@/lib/doceditor/model";
import { ConditionField } from "@/lib/docbuilder/ConditionField";
import { validateExpression } from "@/lib/docbuilder/expr";
import { saveLibraryItem } from "@/app/actions/doclibrary";
import { TextPromptDialog } from "@/components/TextPromptDialog";
import { toast } from "sonner";

const lbl = "block text-[11px] font-medium text-slate-500 mb-1";
const inp = "w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-800 focus:border-orange-400 focus:outline-none";
const row = "mb-3";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-slate-100 p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</div>
      {children}
    </div>
  );
}

export function PropertiesPanel() {
  const doc = useEditor((s) => s.doc);
  const sel = useEditor((s) => s.sel);
  if (!doc) return null;

  const block = sel.blockId ? getBlock(doc, sel.blockId) : null;
  const floating = sel.blockId ? doc.pages.some((p) => p.floatingBlocks.some((fb) => fb.block.id === sel.blockId)) : false;
  const field = sel.fieldId ? doc.pages.flatMap((p) => p.overlayFields).find((f) => f.id === sel.fieldId) ?? null : null;

  return (
    <div className="h-full overflow-y-auto">
      {field ? <FieldProps field={field} /> : block ? <BlockProps block={block} floating={floating} /> : <DocumentProps />}
    </div>
  );
}

// ── field ───────────────────────────────────────────────────────────
function FieldProps({ field }: { field: OverlayField }) {
  const updateField = useEditor((s) => s.updateField);
  const removeField = useEditor((s) => s.removeField);
  const recipients = useEditor((s) => s.doc?.recipients ?? []);
  return (
    <>
      <Section title={`${field.kind} field`}>
        <div className={row}><label className={lbl}>Label</label><input className={inp} value={field.label} placeholder={field.kind} onChange={(e) => updateField(field.id, { label: e.target.value })} /></div>
        <div className={row}>
          <label className={lbl}>Assigned recipient</label>
          <select className={inp} value={field.recipientId ?? ""} onChange={(e) => updateField(field.id, { recipientId: e.target.value || null })}>
            <option value="">Unassigned</option>
            {recipients.map((r) => <option key={r.id} value={r.id}>{r.name || r.email || "Recipient"}</option>)}
          </select>
          {recipients.length === 0 && <p className="mt-1 text-[11px] text-amber-600">Add a recipient below to assign this field.</p>}
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={field.required} onChange={(e) => updateField(field.id, { required: e.target.checked })} /> Required</label>
      </Section>
      <Section title="Position & size">
        <div className="grid grid-cols-2 gap-2">
          <div><label className={lbl}>X</label><input type="number" className={inp} value={Math.round(field.anchor.x)} onChange={(e) => updateField(field.id, { anchor: { ...field.anchor, x: Number(e.target.value) } })} /></div>
          <div><label className={lbl}>Y</label><input type="number" className={inp} value={Math.round(field.anchor.y)} onChange={(e) => updateField(field.id, { anchor: { ...field.anchor, y: Number(e.target.value) } })} /></div>
          <div><label className={lbl}>Width</label><input type="number" className={inp} value={Math.round(field.width)} onChange={(e) => updateField(field.id, { width: Number(e.target.value) })} /></div>
          <div><label className={lbl}>Height</label><input type="number" className={inp} value={Math.round(field.height)} onChange={(e) => updateField(field.id, { height: Number(e.target.value) })} /></div>
        </div>
      </Section>
      <div className="p-3"><button type="button" onClick={() => removeField(field.id)} className="w-full rounded-md border border-red-200 py-1.5 text-sm text-red-600 hover:bg-red-50">Delete field</button></div>
    </>
  );
}

// ── blocks ──────────────────────────────────────────────────────────
function LayoutSection({ block, floating }: { block: DocumentBlock; floating: boolean }) {
  const updateBlock = useEditor((s) => s.updateBlock);
  const detach = useEditor((s) => s.detach);
  const dock = useEditor((s) => s.dock);
  const w = block.settings?.width ?? 100;
  const align = block.settings?.horizontalAlignment ?? "stretch";
  const set = (patch: Partial<DocumentBlock["settings"]>) => updateBlock(block.id, { settings: { ...block.settings, ...patch } } as Partial<DocumentBlock>);
  const alignBtn = (val: "left" | "centre" | "right", label: string) => (
    <button
      type="button" onClick={() => set({ horizontalAlignment: val })}
      className={`flex-1 rounded border px-2 py-1 text-xs ${align === val ? "border-orange-400 bg-orange-50 text-orange-600" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}
    >{label}</button>
  );

  if (floating) {
    return (
      <Section title="Placement">
        <div className="mb-2 rounded-md bg-orange-50 px-2.5 py-2 text-[11px] text-orange-700">📌 Free placement — drag it anywhere on the page; drag the side handles to resize.</div>
        <button type="button" onClick={() => dock(block.id)} className="w-full rounded-md border border-slate-300 py-1.5 text-sm text-slate-700 hover:bg-slate-50">⤵ Dock back into the flow</button>
      </Section>
    );
  }

  return (
    <Section title="Layout">
      <div className={row}>
        <label className={lbl}>Width ({w}%){w >= 100 ? " — full row" : ""}</label>
        <input type="range" min={20} max={100} step={5} className="w-full" value={w} onChange={(e) => set({ width: Number(e.target.value) })} />
      </div>
      {w < 100 && (
        <div className={row}>
          <label className={lbl}>Align on the row</label>
          <div className="flex gap-1">{alignBtn("left", "Left")}{alignBtn("centre", "Centre")}{alignBtn("right", "Right")}</div>
        </div>
      )}
      <button type="button" onClick={() => detach(block.id)} className="w-full rounded-md border border-orange-200 py-1.5 text-sm text-orange-600 hover:bg-orange-50">⤢ Free placement (drag anywhere)</button>
      <p className="mt-2 text-[11px] text-slate-400">Or drop another block on this one’s left/right edge to build columns.</p>
    </Section>
  );
}

function BlockProps({ block, floating }: { block: DocumentBlock; floating: boolean }) {
  const remove = useEditor((s) => s.remove);
  return (
    <>
      <div className="border-b border-slate-100 p-3 text-sm font-medium capitalize text-slate-700">{block.type} block{floating ? " · floating" : ""}</div>
      {block.type !== "pageBreak" && <LayoutSection block={block} floating={floating} />}
      {block.type === "image" && <ImageProps block={block} />}
      {block.type === "pricing" && <PricingProps block={block} />}
      {block.type === "divider" && <DividerProps block={block} />}
      {block.type === "spacer" && <SpacerProps block={block} />}
      {block.type === "conditional" && <ConditionalProps block={block} />}
      {block.type === "banner" && <BannerProps block={block} />}
      {block.type === "infoCard" && <InfoCardProps block={block} />}
      {block.type === "totalBand" && <TotalBandProps block={block} />}
      {block.type === "terms" && <TermsProps block={block} />}
      {block.type === "footer" && <FooterProps block={block} />}
      {block.type === "lineItems" && <LineItemsProps block={block} />}
      {(block.type === "text" || block.type === "heading") && <TextHint block={block} />}
      {block.type === "table" && <p className="p-3 text-xs text-slate-400">Edit table cells inline on the page.</p>}
      {block.type === "pageBreak" && <p className="p-3 text-xs text-slate-400">Forces the next content onto a new page.</p>}
      <div className="space-y-2 p-3">
        <TextPromptDialog
          trigger={<button type="button" className="w-full rounded-md border border-slate-300 py-1.5 text-sm text-slate-700 hover:bg-slate-50">Save to content library</button>}
          title="Save reusable content"
          description="Give this block a clear name so your team can find it in the Library palette."
          label="Library item name"
          placeholder="e.g. Standard warranty terms"
          submitLabel="Save to library"
          onSubmit={async (name) => {
            await saveLibraryItem({ name, category: "", blocks: [block] });
            toast.success("Saved to the content library");
          }}
        />
        <button type="button" onClick={() => remove(block.id)} className="w-full rounded-md border border-red-200 py-1.5 text-sm text-red-600 hover:bg-red-50">Delete block</button>
      </div>
    </>
  );
}

function TextHint({ block }: { block: TextBlock | { type: string } }) {
  void block;
  return <p className="p-3 text-xs text-slate-400">Click the text on the page to edit it directly — bold, headings, and ＋ variable are in the floating toolbar.</p>;
}

function ImageProps({ block }: { block: ImageBlock }) {
  const updateBlock = useEditor((s) => s.updateBlock);
  return (
    <Section title="Image">
      <div className={row}><label className={lbl}>Image URL</label><input className={inp} value={block.src} placeholder="https://… or data:image/…" onChange={(e) => updateBlock(block.id, { src: e.target.value })} /></div>
      <div className={row}><label className={lbl}>Alt text</label><input className={inp} value={block.alt} onChange={(e) => updateBlock(block.id, { alt: e.target.value })} /></div>
      <div className={row}><label className={lbl}>Width ({block.widthPct}%)</label><input type="range" min={10} max={100} className="w-full" value={block.widthPct} onChange={(e) => updateBlock(block.id, { widthPct: Number(e.target.value) }, false)} /></div>
      <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={block.rounded} onChange={(e) => updateBlock(block.id, { rounded: e.target.checked })} /> Rounded corners</label>
    </Section>
  );
}

function DividerProps({ block }: { block: DividerBlock }) {
  const updateBlock = useEditor((s) => s.updateBlock);
  return (
    <Section title="Divider">
      <div className={row}><label className={lbl}>Colour</label><input type="color" value={block.color} onChange={(e) => updateBlock(block.id, { color: e.target.value })} className="h-8 w-full rounded border border-slate-300" /></div>
      <div className={row}><label className={lbl}>Thickness ({block.thickness}px)</label><input type="range" min={0.5} max={6} step={0.5} className="w-full" value={block.thickness} onChange={(e) => updateBlock(block.id, { thickness: Number(e.target.value) }, false)} /></div>
    </Section>
  );
}

function SpacerProps({ block }: { block: SpacerBlock }) {
  const updateBlock = useEditor((s) => s.updateBlock);
  return (
    <Section title="Spacer">
      <label className={lbl}>Height ({block.height}px)</label>
      <input type="range" min={4} max={160} className="w-full" value={block.height} onChange={(e) => updateBlock(block.id, { height: Number(e.target.value) }, false)} />
    </Section>
  );
}

function ConditionalProps({ block }: { block: ConditionalBlock }) {
  const updateBlock = useEditor((s) => s.updateBlock);
  return (
    <Section title="Show when">
      <ConditionField value={block.when} onChange={(v) => updateBlock(block.id, { when: v })} />
      <p className="mt-2 text-[11px] text-slate-400">Drag blocks into this container on the page. They render only when the condition is true against the linked record.</p>
    </Section>
  );
}

function PricingProps({ block }: { block: PricingBlock }) {
  const updateBlock = useEditor((s) => s.updateBlock);
  const setLines = (lines: PricingBlock["lines"]) => updateBlock(block.id, { lines });
  return (
    <>
      <Section title="Pricing options">
        <label className="mb-2 flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={block.bound} onChange={(e) => updateBlock(block.id, { bound: e.target.checked })} /> Auto-fill from linked record</label>
        <label className="mb-2 flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={block.showTax} onChange={(e) => updateBlock(block.id, { showTax: e.target.checked })} /> Show tax column</label>
        <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={block.showDiscount} onChange={(e) => updateBlock(block.id, { showDiscount: e.target.checked })} /> Show discount column</label>
      </Section>
      {!block.bound && (
        <Section title="Line items">
          <div className="space-y-2">
            {block.lines.map((line, i) => (
              <div key={line.id} className="rounded-md border border-slate-200 p-2">
                <input className={`${inp} mb-1`} value={line.name} placeholder="Item name" onChange={(e) => setLines(block.lines.map((l, j) => (j === i ? { ...l, name: e.target.value } : l)))} />
                <div className="grid grid-cols-3 gap-1">
                  <input type="number" className={inp} title="Qty" value={line.qty} onChange={(e) => setLines(block.lines.map((l, j) => (j === i ? { ...l, qty: Number(e.target.value) } : l)))} />
                  <input type="number" className={inp} title="Unit price" value={line.unitPrice} onChange={(e) => setLines(block.lines.map((l, j) => (j === i ? { ...l, unitPrice: Number(e.target.value) } : l)))} />
                  <input type="number" className={inp} title="Discount %" value={line.discountPct} onChange={(e) => setLines(block.lines.map((l, j) => (j === i ? { ...l, discountPct: Number(e.target.value) } : l)))} />
                </div>
                <button type="button" className="mt-1 text-[11px] text-red-500 hover:underline" onClick={() => setLines(block.lines.filter((_, j) => j !== i))}>Remove</button>
              </div>
            ))}
            <button type="button" className="w-full rounded-md border border-dashed border-slate-300 py-1.5 text-sm text-slate-500 hover:border-orange-300 hover:text-orange-600" onClick={() => setLines([...block.lines, newPricingLine()])}>＋ Add line</button>
          </div>
        </Section>
      )}
    </>
  );
}

function BannerProps({ block }: { block: BannerBlock }) {
  const updateBlock = useEditor((s) => s.updateBlock);
  return (
    <Section title="Brand banner">
      <div className={row}><label className={lbl}>Title</label><input className={inp} value={block.title} onChange={(e) => updateBlock(block.id, { title: e.target.value })} /></div>
      <div className={row}><label className={lbl}>Number (supports {"{{quote.number}}"})</label><input className={inp} value={block.docNumber} onChange={(e) => updateBlock(block.id, { docNumber: e.target.value })} /></div>
      <div className="grid grid-cols-2 gap-2">
        <div><label className={lbl}>Background</label><input type="color" value={block.bg} onChange={(e) => updateBlock(block.id, { bg: e.target.value })} className="h-8 w-full rounded border border-slate-300" /></div>
        <div><label className={lbl}>Accent</label><input type="color" value={block.accent} onChange={(e) => updateBlock(block.id, { accent: e.target.value })} className="h-8 w-full rounded border border-slate-300" /></div>
      </div>
      <label className="mt-2 flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={block.showLogo} onChange={(e) => updateBlock(block.id, { showLogo: e.target.checked })} /> Show Denago logo</label>
    </Section>
  );
}

function InfoCardProps({ block }: { block: InfoCardBlock }) {
  const updateBlock = useEditor((s) => s.updateBlock);
  return (
    <Section title="Info card">
      <div className={row}><label className={lbl}>Label</label><input className={inp} value={block.label} onChange={(e) => updateBlock(block.id, { label: e.target.value })} /></div>
      <div className={row}><label className={lbl}>Name (merge fields OK)</label><input className={inp} value={block.name} onChange={(e) => updateBlock(block.id, { name: e.target.value })} /></div>
      <div className={row}><label className={lbl}>Lines</label><textarea className={inp} rows={3} value={block.lines} onChange={(e) => updateBlock(block.id, { lines: e.target.value })} /></div>
      <div><label className={lbl}>Accent</label><input type="color" value={block.accent} onChange={(e) => updateBlock(block.id, { accent: e.target.value })} className="h-8 w-full rounded border border-slate-300" /></div>
    </Section>
  );
}

function TotalBandProps({ block }: { block: TotalBandBlock }) {
  const updateBlock = useEditor((s) => s.updateBlock);
  return (
    <Section title="Total band">
      <div className={row}><label className={lbl}>Label</label><input className={inp} value={block.label} onChange={(e) => updateBlock(block.id, { label: e.target.value })} /></div>
      <div className={row}><label className={lbl}>Amount (supports {"{{quote.total}}"})</label><input className={inp} value={block.amount} onChange={(e) => updateBlock(block.id, { amount: e.target.value })} /></div>
      <div><label className={lbl}>Colour</label><input type="color" value={block.color} onChange={(e) => updateBlock(block.id, { color: e.target.value })} className="h-8 w-full rounded border border-slate-300" /></div>
    </Section>
  );
}

function TermsProps({ block }: { block: TermsBlock }) {
  const updateBlock = useEditor((s) => s.updateBlock);
  const set = (items: TermsBlock["items"]) => updateBlock(block.id, { items });
  return (
    <Section title="Terms">
      <div className={row}><label className={lbl}>Title</label><input className={inp} value={block.title} onChange={(e) => updateBlock(block.id, { title: e.target.value })} /></div>
      <div className="space-y-1">
        {block.items.map((it, i) => (
          <div key={i} className="flex gap-1">
            <input className={inp} value={it.text} onChange={(e) => set(block.items.map((x, j) => (j === i ? { text: e.target.value } : x)))} />
            <button type="button" className="px-1 text-red-500" onClick={() => set(block.items.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        <button type="button" className="w-full rounded-md border border-dashed border-slate-300 py-1 text-xs text-slate-500 hover:border-orange-300 hover:text-orange-600" onClick={() => set([...block.items, { text: "New term" }])}>＋ Add term</button>
      </div>
    </Section>
  );
}

function FooterProps({ block }: { block: FooterBlock }) {
  const updateBlock = useEditor((s) => s.updateBlock);
  const set = (lines: FooterBlock["lines"]) => updateBlock(block.id, { lines });
  const brand = block.variant !== "simple";
  return (
    <Section title="Footer">
      <div className={row}>
        <label className={lbl}>Style</label>
        <select className={inp} value={brand ? "brand" : "simple"} onChange={(e) => updateBlock(block.id, { variant: e.target.value as "brand" | "simple" })}>
          <option value="brand">Brand (Company Profile)</option>
          <option value="simple">Simple lines</option>
        </select>
      </div>
      {brand ? (
        <p className="text-[11px] leading-4 text-slate-500">
          Shows your company name, contact details and social handles, pulled from the Company Profile (Settings → Company). Edit it there to update every document footer at once.
        </p>
      ) : (
        <>
          <div className={row}><label className={lbl}>Rule colour</label><input type="color" value={block.accent} onChange={(e) => updateBlock(block.id, { accent: e.target.value })} className="h-8 w-full rounded border border-slate-300" /></div>
          <div className="space-y-1">
            {block.lines.map((l, i) => (
              <div key={i} className="flex gap-1">
                <input className={inp} value={l.text} onChange={(e) => set(block.lines.map((x, j) => (j === i ? { text: e.target.value } : x)))} />
                <button type="button" className="px-1 text-red-500" onClick={() => set(block.lines.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
            <button type="button" className="w-full rounded-md border border-dashed border-slate-300 py-1 text-xs text-slate-500 hover:border-orange-300 hover:text-orange-600" onClick={() => set([...block.lines, { text: "New line" }])}>＋ Add line</button>
          </div>
        </>
      )}
    </Section>
  );
}

const COL_LABEL: Record<LineItemColumn["key"], string> = {
  description: "Description",
  qty: "Quantity",
  unitPrice: "Unit price (incl VAT)",
  unitPriceExVat: "Unit price (excl VAT)",
  vat: "VAT amount",
  subtotal: "Line total (excl VAT)",
  total: "Line total (incl VAT)",
};

function LineItemsProps({ block }: { block: LineItemsBlock }) {
  const updateBlock = useEditor((s) => s.updateBlock);
  const setCols = (columns: LineItemColumn[]) => updateBlock(block.id, { columns });
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir; if (j < 0 || j >= block.columns.length) return;
    const c = [...block.columns]; [c[i], c[j]] = [c[j], c[i]]; setCols(c);
  };
  const hasVat = block.columns.some((c) => c.key === "vat");
  return (
    <>
      <Section title="Header colours">
        <div className="grid grid-cols-2 gap-2">
          <div><label className={lbl}>Background</label><input type="color" value={block.headerBg} onChange={(e) => updateBlock(block.id, { headerBg: e.target.value })} className="h-8 w-full rounded border border-slate-300" /></div>
          <div><label className={lbl}>Text</label><input type="color" value={block.headerColor} onChange={(e) => updateBlock(block.id, { headerColor: e.target.value })} className="h-8 w-full rounded border border-slate-300" /></div>
        </div>
        {hasVat && (
          <div className="mt-2"><label className={lbl}>VAT rate (%) — prices are VAT-inclusive</label><input type="number" className={inp} value={block.vatRate} onChange={(e) => updateBlock(block.id, { vatRate: Number(e.target.value) })} /></div>
        )}
      </Section>
      <Section title="Columns">
        <div className="space-y-2">
          {block.columns.map((c, i) => (
            <div key={i} className="rounded-md border border-slate-200 p-2">
              <div className="mb-1 flex items-center gap-1">
                <select className={inp} value={c.key} onChange={(e) => setCols(block.columns.map((x, j) => (j === i ? { ...x, key: e.target.value as LineItemColumn["key"], header: x.header || COL_LABEL[e.target.value as LineItemColumn["key"]] } : x)))}>
                  {lineItemColKeys.map((k) => <option key={k} value={k}>{COL_LABEL[k]}</option>)}
                </select>
                <button type="button" className="px-1 text-slate-400 hover:text-slate-700" title="Move up" onClick={() => move(i, -1)}>▲</button>
                <button type="button" className="px-1 text-slate-400 hover:text-slate-700" title="Move down" onClick={() => move(i, 1)}>▼</button>
                <button type="button" className="px-1 text-red-500" title="Remove" onClick={() => setCols(block.columns.filter((_, j) => j !== i))}>✕</button>
              </div>
              <div className="mb-1 flex gap-1">
                <input className={inp} value={c.header} placeholder="Column heading" onChange={(e) => setCols(block.columns.map((x, j) => (j === i ? { ...x, header: e.target.value } : x)))} />
                <select className="rounded border border-slate-300 px-1 text-xs" value={c.align} onChange={(e) => setCols(block.columns.map((x, j) => (j === i ? { ...x, align: e.target.value as "left" | "right" } : x)))}>
                  <option value="left">Left</option><option value="right">Right</option>
                </select>
              </div>
              <input
                className={`w-full rounded-md border px-2 py-1 text-xs ${validateExpression(c.showIf) ? "border-red-400" : "border-slate-200"}`}
                value={c.showIf} placeholder="Show if… (blank = always)  e.g. quotation.total > 100000"
                onChange={(e) => setCols(block.columns.map((x, j) => (j === i ? { ...x, showIf: e.target.value } : x)))}
              />
              {validateExpression(c.showIf) && <div className="mt-0.5 text-[10px] text-red-500">⚠ {validateExpression(c.showIf)}</div>}
            </div>
          ))}
          <button type="button" className="w-full rounded-md border border-dashed border-slate-300 py-1.5 text-sm text-slate-500 hover:border-orange-300 hover:text-orange-600"
            onClick={() => setCols([...block.columns, { key: "vat", header: "VAT", align: "right", showIf: "" }])}>＋ Add column (VAT, discount, etc.)</button>
        </div>
        <p className="mt-2 text-[11px] text-slate-400">Columns fill from the linked quote / job card. Add a “Show if” condition to make any column appear only when it applies — hiding a column never affects the others’ maths.</p>
      </Section>
    </>
  );
}

// ── document + recipients ───────────────────────────────────────────
function DocumentProps() {
  const doc = useEditor((s) => s.doc)!;
  const setStyle = useEditor((s) => s.setStyle);
  const setTitle = useEditor((s) => s.setTitle);
  const addRecipient = useEditor((s) => s.addRecipient);
  const updateRecipient = useEditor((s) => s.updateRecipient);
  const removeRecipient = useEditor((s) => s.removeRecipient);
  return (
    <>
      <Section title="Document">
        <div className={row}><label className={lbl}>Title</label><input className={inp} value={doc.title} onChange={(e) => setTitle(e.target.value)} /></div>
        <div className="grid grid-cols-2 gap-2">
          <div><label className={lbl}>Page size</label>
            <select className={inp} value={doc.style.pageSize} onChange={(e) => setStyle({ pageSize: e.target.value as "A4" | "Letter" })}><option value="A4">A4</option><option value="Letter">Letter</option></select>
          </div>
          <div><label className={lbl}>Font</label>
            <select className={inp} value={doc.style.fontFamily} onChange={(e) => setStyle({ fontFamily: e.target.value as "sans" | "serif" | "mono" })}><option value="sans">Sans</option><option value="serif">Serif</option><option value="mono">Mono</option></select>
          </div>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <div><label className={lbl}>Margin ({doc.style.margin}px)</label><input type="range" min={16} max={96} className="w-full" value={doc.style.margin} onChange={(e) => setStyle({ margin: Number(e.target.value) })} /></div>
          <div><label className={lbl}>Accent</label><input type="color" value={doc.style.accent} onChange={(e) => setStyle({ accent: e.target.value })} className="h-8 w-full rounded border border-slate-300" /></div>
        </div>
      </Section>
      <Section title="Recipients">
        <div className="space-y-2">
          {doc.recipients.map((r) => (
            <div key={r.id} className="rounded-md border border-slate-200 p-2">
              <div className="mb-1 flex items-center gap-2">
                <span className="h-3 w-3 rounded-full" style={{ background: r.color }} />
                <input className={inp} value={r.name} placeholder="Name" onChange={(e) => updateRecipient(r.id, { name: e.target.value })} />
              </div>
              <input className={`${inp} mb-1`} value={r.email} placeholder="Email" onChange={(e) => updateRecipient(r.id, { email: e.target.value })} />
              <div className="flex items-center justify-between">
                <select className="rounded border border-slate-300 px-1 py-1 text-xs" value={r.role} onChange={(e) => updateRecipient(r.id, { role: e.target.value as "signer" | "viewer" | "approver" })}>
                  <option value="signer">Signer</option><option value="approver">Approver</option><option value="viewer">Viewer</option>
                </select>
                <button type="button" className="text-[11px] text-red-500 hover:underline" onClick={() => removeRecipient(r.id)}>Remove</button>
              </div>
            </div>
          ))}
          <button type="button" className="w-full rounded-md border border-dashed border-slate-300 py-1.5 text-sm text-slate-500 hover:border-blue-300 hover:text-blue-600" onClick={() => addRecipient()}>＋ Add recipient</button>
        </div>
      </Section>
    </>
  );
}

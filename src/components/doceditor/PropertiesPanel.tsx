"use client";

import { useEditor } from "@/lib/doceditor/store";
import { getBlock } from "@/lib/doceditor/ops";
import { newPricingLine } from "@/lib/doceditor/factory";
import type { DocumentBlock, OverlayField, Recipient, PricingBlock, ImageBlock, DividerBlock, SpacerBlock, ConditionalBlock, TextBlock, BannerBlock, InfoCardBlock, TotalBandBlock, TermsBlock, FooterBlock, LineItemsBlock, LineItemColumn, EmailButtonBlock, EmailFactsBlock, EmailFooterBlock, EmailHeaderBlock, EmailSignatureBlock } from "@/lib/doceditor/model";
import { cssColor } from "@/lib/doceditor/css";
import { activePreset, recolour, STYLE_PRESETS } from "@/lib/doceditor/docStyles";
import type { DocStyle } from "@/lib/doceditor/model";
import { lineItemColKeys } from "@/lib/doceditor/model";
import { recipientLabel } from "@/lib/signing/templateRecipients";
import { ConditionField } from "@/lib/docbuilder/ConditionField";
import { validateExpression } from "@/lib/docbuilder/expr";
import { saveLibraryItem } from "@/app/actions/doclibrary";
import { sectionFromSelection } from "@/lib/doceditor/librarySection";
import { toast } from "sonner";
import { ShowcaseProps } from "./ShowcaseProps";
import { DesignSection } from "./DesignSection";
import { AlignOnPage, ArrangePanel } from "./ArrangePanel";
import { TableStyleControls } from "./TableStyleControls";
import { ContentBlockProps } from "./ContentBlockProps";
import { RowSection, RunningSection } from "./PageFurnitureProps";
import { IMAGE_ASPECT_LABELS, type ImageAspect } from "@/lib/doceditor/imageFrame";
import { useState } from "react";
import { uploadDocEditorImage } from "@/app/actions/doceditor";
import { checkDocImage, DOC_IMAGE_ACCEPT } from "@/lib/doceditor/imageUpload";
import { storedFileSrc } from "@/lib/storedFileSrc";
import { useDocEditorEnv } from "./EditorContext";

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
  const picked = useEditor((s) => s.picked);
  if (!doc) return null;

  const block = sel.blockId ? getBlock(doc, sel.blockId) : null;
  const floating = sel.blockId ? doc.pages.some((p) => p.floatingBlocks.some((fb) => fb.block.id === sel.blockId)) : false;
  const field = sel.fieldId ? doc.pages.flatMap((p) => p.overlayFields).find((f) => f.id === sel.fieldId) ?? null : null;

  return (
    <div className="h-full overflow-y-auto">
      {picked.length >= 2 ? <ArrangePanel ids={picked} /> : field ? <FieldProps field={field} /> : block ? <BlockProps block={block} floating={floating} /> : <DocumentProps />}
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
          {/* A date field is never typed by anyone — it is stamped with the
              moment its signature is applied. So the question is not "who fills
              this in" but "which signature does it date". */}
          <label className={lbl}>{field.kind === "date" ? "Dates whose signature?" : "Assigned recipient"}</label>
          <select className={inp} value={field.recipientId ?? ""} onChange={(e) => updateField(field.id, { recipientId: e.target.value || null })}>
            <option value="">Unassigned</option>
            {recipients.map((r) => <option key={r.id} value={r.id}>{recipientLabel(r)}</option>)}
          </select>
          {field.kind === "date" ? (
            <p className="mt-1 text-[11px] text-slate-500">
              {field.recipientId
                ? "Stamped automatically the moment they sign — the signer is never asked to type it."
                : "Unassigned, so it is stamped with the date the document is completed. Assign it to a party to date that party’s signature instead."}
            </p>
          ) : recipients.length === 0 ? (
            <p className="mt-1 text-[11px] text-amber-600">
              Add a recipient below — set one to “Our team” and one to “The customer”, then assign this field to whichever signs here.
            </p>
          ) : !field.recipientId ? (
            <p className="mt-1 text-[11px] text-amber-600">
              An unassigned field is filled by whoever opens the document first. Assign it so the signature lands in the right box — and so your team&apos;s can be applied automatically.
            </p>
          ) : null}
        </div>
        {field.kind !== "date" && (
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={field.required} onChange={(e) => updateField(field.id, { required: e.target.checked })} /> Required</label>
        )}
      </Section>
      <Section title="Position & size">
        <AlignOnPage id={field.id} />
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
/** Exact position and width for a freely placed block — typing a number is the only way to line two things up precisely. */
function FloatingPosition({ blockId }: { blockId: string }) {
  const placed = useEditor((s) => s.doc?.pages.flatMap((p) => p.floatingBlocks).find((fb) => fb.block.id === blockId));
  const updateFloating = useEditor((s) => s.updateFloating);
  if (!placed) return null;
  const field = (label: string, key: "x" | "y" | "width", min: number) => (
    <label className="flex-1 text-[11px] font-medium text-slate-500">{label}
      <input
        type="number" min={min} step={1} className={inp} value={Math.round(placed[key])}
        onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) updateFloating(blockId, { [key]: Math.max(min, n) }); }}
      />
    </label>
  );
  return <div className={`${row} flex gap-2`}>{field("From left", "x", 0)}{field("From top", "y", 0)}{field("Width", "width", 60)}</div>;
}

function LayoutSection({ block, floating }: { block: DocumentBlock; floating: boolean }) {
  const updateBlock = useEditor((s) => s.updateBlock);
  const detach = useEditor((s) => s.detach);
  const dock = useEditor((s) => s.dock);
  const w = block.settings?.width ?? 100;
  const align = block.settings?.horizontalAlignment ?? "stretch";
  const scale = block.settings?.fontScale ?? 1;
  const textAlign = block.settings?.textAlign;
  const set = (patch: Partial<DocumentBlock["settings"]>) => updateBlock(block.id, { settings: { ...block.settings, ...patch } } as Partial<DocumentBlock>);
  const alignBtn = (val: "left" | "centre" | "right", label: string) => (
    <button
      type="button" onClick={() => set({ horizontalAlignment: val })}
      className={`flex-1 rounded border px-2 py-1 text-xs ${align === val ? "border-orange-400 bg-orange-50 text-orange-600" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}
    >{label}</button>
  );
  const textAlignBtn = (val: "left" | "centre" | "right", label: string) => (
    <button
      type="button" onClick={() => set({ textAlign: textAlign === val ? undefined : val })}
      className={`flex-1 rounded border px-2 py-1 text-xs ${textAlign === val ? "border-orange-400 bg-orange-50 text-orange-600" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}
    >{label}</button>
  );

  // Text size and alignment: the same two controls whether the block sits in
  // the flow or is placed freely. They used to vanish for a floated block.
  const typeControls = (
    <>
      <div className={row}>
        <label className={lbl}>Text size ({Math.round(scale * 100)}%)</label>
        <input
          type="range" min={60} max={200} step={5} className="w-full" value={Math.round(scale * 100)}
          onChange={(e) => set({ fontScale: Number(e.target.value) / 100 })}
        />
        {scale !== 1 && (
          <button type="button" className="mt-1 text-[11px] text-slate-500 underline hover:text-slate-700" onClick={() => set({ fontScale: undefined })}>
            Reset to the block&apos;s own size
          </button>
        )}
      </div>
      <div className={row}>
        <label className={lbl}>Text alignment{textAlign ? "" : " — as designed"}</label>
        <div className="flex gap-1">{textAlignBtn("left", "Left")}{textAlignBtn("centre", "Centre")}{textAlignBtn("right", "Right")}</div>
      </div>
    </>
  );

  if (floating) {
    return (
      <Section title="Placement">
        <div className="mb-2 rounded-md bg-orange-50 px-2.5 py-2 text-[11px] text-orange-700">📌 Free placement — drag it anywhere on the page; drag the side handles to resize.</div>
        <FloatingPosition blockId={block.id} />
        <AlignOnPage id={block.id} />
        {typeControls}
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
      {/* The total band places itself on the row even at full width — it is a
          band, not a paragraph — so it gets this control regardless. */}
      {(w < 100 || block.type === "totalBand") && (
        <div className={row}>
          <label className={lbl}>Align on the row</label>
          <div className="flex gap-1">{alignBtn("left", "Left")}{alignBtn("centre", "Centre")}{alignBtn("right", "Right")}</div>
        </div>
      )}
      {typeControls}
      <button type="button" onClick={() => detach(block.id)} className="w-full rounded-md border border-orange-200 py-1.5 text-sm text-orange-600 hover:bg-orange-50">⤢ Free placement (drag anywhere)</button>
      <p className="mt-2 text-[11px] text-slate-400">Or drop another block on this one’s left/right edge to build columns.</p>
    </Section>
  );
}

/** A plain table's shape: its columns, how many rows, and the heading colours. The words are typed on the page. */
function TableProps({ block }: { block: Extract<DocumentBlock, { type: "table" }> }) {
  const updateBlock = useEditor((s) => s.updateBlock);
  const set = (patch: Partial<typeof block>) => updateBlock(block.id, patch as Partial<DocumentBlock>);
  const columns = block.columns;
  const setColumn = (i: number, patch: Partial<(typeof columns)[number]>) => set({ columns: columns.map((c, ci) => (ci === i ? { ...c, ...patch } : c)) });
  const emptyRow = () => ({ cells: columns.map(() => ({ value: "" })) });
  const setRows = (rows: typeof block.rows) => set({ rows });
  const moveRow = (i: number, by: -1 | 1) => { const rows = [...block.rows]; [rows[i], rows[i + by]] = [rows[i + by], rows[i]]; setRows(rows); };
  return (
    <Section title="Table">
      <p className="mb-2 text-[11px] text-slate-500">Click a heading or a cell on the page to type in it.</p>
      <label className={lbl}>Columns</label>
      <ul className="mb-2 space-y-1.5">
        {columns.map((c, i) => (
          <li key={i} className="flex items-center gap-1">
            <span className="min-w-0 flex-1 truncate text-xs text-slate-700" title={c.header}>{c.header || `Column ${i + 1}`}</span>
            <select aria-label={`Alignment of column ${i + 1}`} className="rounded border border-slate-300 px-1 py-1 text-xs text-slate-700" value={c.align} onChange={(e) => setColumn(i, { align: e.target.value as typeof c.align })}>
              <option value="left">Left</option><option value="center">Centre</option><option value="right">Right</option>
            </select>
            <input aria-label={`Width of column ${i + 1}, percent`} type="number" min={5} max={90} step={5} className="w-14 rounded border border-slate-300 px-1 py-1 text-xs text-slate-700" value={c.widthPct} onChange={(e) => setColumn(i, { widthPct: Math.max(5, Math.min(90, Number(e.target.value) || 5)) })} />
            <button
              type="button" className="rounded px-1 text-xs text-red-500 hover:bg-red-50 disabled:opacity-30" title="Remove this column" aria-label={`Remove column ${i + 1}`} disabled={columns.length <= 1}
              // The column goes with its cells, in every row.
              onClick={() => set({ columns: columns.filter((_, ci) => ci !== i), rows: block.rows.map((r) => ({ ...r, cells: r.cells.filter((_, ci) => ci !== i) })) })}
            >✕</button>
          </li>
        ))}
      </ul>
      <div className="mb-3 flex gap-1.5">
        <button type="button" className="flex-1 rounded-md border border-slate-300 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-40" disabled={columns.length >= 8} onClick={() => set({ columns: [...columns, { header: "", align: "left", widthPct: 20 }], rows: block.rows.map((r) => ({ ...r, cells: [...columns.map((_, ci) => r.cells[ci] ?? { value: "" }), { value: "" }] })) })}>+ Column</button>
        <button type="button" className="flex-1 rounded-md border border-slate-300 py-1 text-xs text-slate-700 hover:bg-slate-50" onClick={() => set({ rows: [...block.rows, emptyRow()] })}>+ Row</button>
        <button type="button" className="flex-1 rounded-md border border-slate-300 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-40" disabled={block.rows.length === 0} title="Remove the last row" onClick={() => set({ rows: block.rows.slice(0, -1) })}>− Row</button>
      </div>
      <div className="flex gap-2">
        <div className="flex-1"><label className={lbl}>Heading fill</label><input type="color" value={block.headerBg} onChange={(e) => set({ headerBg: e.target.value })} className="h-8 w-full rounded border border-slate-300" /></div>
        <div className="flex-1"><label className={lbl}>Heading text</label><input type="color" value={block.headerColor} onChange={(e) => set({ headerColor: e.target.value })} className="h-8 w-full rounded border border-slate-300" /></div>
      </div>
      <div className="mt-3"><TableStyleControls value={block.tableStyle} onChange={(tableStyle) => set({ tableStyle })} /></div>
      {block.rows.length > 0 && (
        <>
          <label className={`${lbl} mt-3`}>Rows</label>
          <ul className="space-y-1">
            {block.rows.map((r, i) => (
              <li key={i} className="flex items-center gap-1">
                <span className="min-w-0 flex-1 truncate text-xs text-slate-700" title={r.cells[0]?.value}>{r.cells[0]?.value || `Row ${i + 1}`}</span>
                {/* A group heading spans the table; a subtotal is bold with a rule above it. Its figures are typed, not added up. */}
                <select aria-label={`Kind of row ${i + 1}`} className="rounded border border-slate-300 px-1 py-1 text-xs text-slate-700" value={r.kind ?? ""} onChange={(e) => setRows(block.rows.map((x, ri) => (ri === i ? { cells: x.cells, ...(e.target.value ? { kind: e.target.value as "group" | "subtotal" } : {}) } : x)))}>
                  <option value="">Row</option><option value="group">Group heading</option><option value="subtotal">Subtotal</option>
                </select>
                <button type="button" className="rounded px-1 text-xs text-slate-400 hover:text-slate-700 disabled:opacity-30" title="Move up" aria-label={`Move row ${i + 1} up`} disabled={i === 0} onClick={() => moveRow(i, -1)}>▲</button>
                <button type="button" className="rounded px-1 text-xs text-slate-400 hover:text-slate-700 disabled:opacity-30" title="Move down" aria-label={`Move row ${i + 1} down`} disabled={i === block.rows.length - 1} onClick={() => moveRow(i, 1)}>▼</button>
                <button type="button" className="rounded px-1 text-xs text-red-500 hover:bg-red-50" title="Remove this row" aria-label={`Remove row ${i + 1}`} onClick={() => setRows(block.rows.filter((_, ri) => ri !== i))}>✕</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

const FRAME_PARTS = new Set<string>(["emailHeader", "emailBody", "emailSignature", "emailFooter"]);
/** Plain names for the email blocks ("emailHeader block" is the code's name, not the owner's). */
const EMAIL_BLOCK_NAMES: Record<string, string> = {
  emailHeader: "Header", emailBody: "Message slot", emailSignature: "Signature", emailFooter: "Footer", emailButton: "Button", emailFacts: "Key figures",
  detailsGrid: "Details grid", paymentSchedule: "Payment schedule", comparison: "Comparison table", callout: "Callout", gallery: "Photo gallery", qr: "QR code",
};

/**
 * Save the selection to the content library: this block, its whole row of
 * columns, or — for a freely placed block — the block where it sits, with an
 * acceptance card's signature and date. Named, and filed under a category.
 */
function SaveToLibrary({ block, floating }: { block: DocumentBlock; floating: boolean }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [scope, setScope] = useState<"block" | "row">("block");
  const [busy, setBusy] = useState(false);
  // How many columns the block's row has: a single-column row IS the block, so the choice is not offered.
  const columns = useEditor((s) => s.doc?.pages.flatMap((p) => p.rows).find((r) => r.columns.some((c) => c.blocks.some((b) => b.id === block.id)))?.columns.length ?? 1);
  const save = async () => {
    const doc = useEditor.getState().doc;
    const section = doc ? sectionFromSelection(doc, block.id, scope) : null;
    if (!section || !name.trim()) return;
    setBusy(true);
    try {
      const result = await saveLibraryItem({ name, category, section });
      if (!result.ok) { toast.error("That could not be saved to the library."); return; }
      toast.success(`Saved to the content library${section.fields.length ? `, with its ${section.fields.length} signing field${section.fields.length === 1 ? "" : "s"}` : ""}`);
      setOpen(false); setName("");
    } catch {
      toast.error("That did not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };
  if (!open) return <button type="button" onClick={() => setOpen(true)} className="w-full rounded-md border border-slate-300 py-1.5 text-sm text-slate-700 hover:bg-slate-50">Save to content library</button>;
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-2.5">
      <label className={lbl} htmlFor={`lib-name-${block.id}`}>Name</label>
      <input id={`lib-name-${block.id}`} className={`${inp} mb-2`} value={name} autoFocus placeholder="e.g. Standard warranty terms" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void save(); }} />
      <label className={lbl} htmlFor={`lib-cat-${block.id}`}>Category (optional)</label>
      <input id={`lib-cat-${block.id}`} className={`${inp} mb-2`} value={category} placeholder="e.g. Terms, Headers, Payment" onChange={(e) => setCategory(e.target.value)} />
      {floating ? (
        <p className="mb-2 text-[11px] text-slate-500">Saved where it sits on the page{block.type === "acceptance" ? ", with the signature and date on its lines" : ""}.</p>
      ) : columns > 1 ? (
        <div className="mb-2 flex gap-1">
          {([["block", "This block"], ["row", `Its whole row (${columns} columns)`]] as const).map(([value, label]) => (
            <button key={value} type="button" onClick={() => setScope(value)} className={`flex-1 rounded border px-2 py-1 text-xs ${scope === value ? "border-orange-400 bg-orange-50 text-orange-600" : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"}`}>{label}</button>
          ))}
        </div>
      ) : null}
      <div className="flex gap-1.5">
        <button type="button" disabled={busy || !name.trim()} onClick={() => void save()} className="flex-1 rounded-md bg-slate-900 py-1.5 text-sm text-white hover:bg-slate-800 disabled:opacity-40">{busy ? "Saving…" : "Save"}</button>
        <button type="button" onClick={() => setOpen(false)} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">Cancel</button>
      </div>
    </div>
  );
}

function BlockProps({ block, floating }: { block: DocumentBlock; floating: boolean }) {
  const remove = useEditor((s) => s.remove);
  const { email } = useDocEditorEnv();
  return (
    <>
      <div className="border-b border-slate-100 p-3 text-sm font-medium capitalize text-slate-700">{EMAIL_BLOCK_NAMES[block.type] ?? `${block.type} block`}{floating ? " · floating" : ""}</div>
      {/* The frame's own parts run the width of the email: no column width, text scale or free placement. */}
      {block.type !== "pageBreak" && !FRAME_PARTS.has(block.type) && <LayoutSection block={block} floating={floating} />}
      {/* One set of design controls for every document block. An email is laid out by its frame and its client, not by these. */}
      {block.type !== "pageBreak" && !FRAME_PARTS.has(block.type) && !block.type.startsWith("email") && <DesignSection block={block} floating={floating} />}
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
      {(block.type === "showcaseHeader" || block.type === "infoStrip" || block.type === "vehicleShowcase" || block.type === "totalsBox" || block.type === "acceptance" || block.type === "footerBand") && <ShowcaseProps block={block} />}
      {(block.type === "detailsGrid" || block.type === "paymentSchedule" || block.type === "comparison" || block.type === "callout" || block.type === "gallery" || block.type === "qr") && <ContentBlockProps block={block} />}
      {block.type === "emailButton" && <EmailButtonProps block={block} />}
      {block.type === "emailFacts" && <EmailFactsProps block={block} />}
      {block.type === "emailFooter" && <EmailFooterProps block={block} />}
      {block.type === "emailHeader" && <EmailHeaderProps block={block} />}
      {block.type === "emailSignature" && <EmailSignatureProps block={block} />}
      {block.type === "emailBody" && <p className="p-3 text-xs text-slate-500">Where each email&apos;s own content goes. Keep exactly one.</p>}
      {(block.type === "text" || block.type === "heading") && <TextHint block={block} />}
      {block.type === "table" && <TableProps block={block} />}
      {block.type === "pageBreak" && <p className="p-3 text-xs text-slate-400">Forces the next content onto a new page.</p>}
      {/* An email has no pages; a freely placed block is in no row. */}
      {!floating && !email && block.type !== "pageBreak" && <RowSection block={block} />}
      <div className="space-y-2 p-3">
        <SaveToLibrary block={block} floating={floating} />
        <button type="button" onClick={() => remove(block.id)} className="w-full rounded-md border border-red-200 py-1.5 text-sm text-red-600 hover:bg-red-50">Delete block</button>
      </div>
    </>
  );
}

function TextHint({ block }: { block: TextBlock | { type: string } }) {
  void block;
  return <p className="p-3 text-xs text-slate-400">Click the text on the page to edit it directly — bold, headings, and ＋ variable are in the floating toolbar.</p>;
}

/**
 * A shape for the picture, how it sits in it, and a caption. Replacing the
 * picture (above) keeps all of this, so a layout survives a new photo.
 */
function ImageFraming({ block }: { block: ImageBlock }) {
  const updateBlock = useEditor((s) => s.updateBlock);
  const set = (patch: Partial<ImageBlock>, history = true) => updateBlock(block.id, patch as Partial<DocumentBlock>, history);
  const shaped = !!block.aspect && block.aspect !== "original";
  const filling = shaped && block.fit !== "contain";
  return (
    <div className="mt-3 border-t border-slate-100 pt-3">
      <div className={row}>
        <label className={lbl} htmlFor={`aspect-${block.id}`}>Shape</label>
        <select id={`aspect-${block.id}`} className={inp} value={block.aspect ?? "original"} onChange={(e) => set({ aspect: e.target.value === "original" ? undefined : (e.target.value as ImageAspect) })}>
          <option value="original">As the picture is</option>
          {(Object.keys(IMAGE_ASPECT_LABELS) as ImageAspect[]).map((a) => <option key={a} value={a}>{IMAGE_ASPECT_LABELS[a]}</option>)}
        </select>
      </div>
      {shaped && (
        <div className={row}>
          <label className={lbl}>In that shape, the picture</label>
          <div className="flex gap-1">
            {([["cover", "Fills it (cropped)"], ["contain", "Fits inside it"]] as const).map(([value, label]) => (
              <button key={value} type="button" onClick={() => set({ fit: value === "cover" ? undefined : value })}
                className={`flex-1 rounded border px-2 py-1 text-xs ${(block.fit ?? "cover") === value ? "border-orange-400 bg-orange-50 text-orange-600" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}>{label}</button>
            ))}
          </div>
        </div>
      )}
      {filling && (
        <div className={row}>
          <label className={lbl}>Keep in view — across ({Math.round(block.focalX ?? 50)}%)</label>
          <input type="range" min={0} max={100} className="w-full" value={block.focalX ?? 50} onChange={(e) => set({ focalX: Number(e.target.value) }, false)} />
          <label className={`${lbl} mt-2`}>Keep in view — down ({Math.round(block.focalY ?? 50)}%)</label>
          <input type="range" min={0} max={100} className="w-full" value={block.focalY ?? 50} onChange={(e) => set({ focalY: Number(e.target.value) }, false)} />
          <p className="mt-1 text-[11px] text-slate-400">Nothing is cut from the file — move these and the rest of the picture is still there.</p>
        </div>
      )}
      <div className={row}><label className={lbl}>Caption</label><input className={inp} value={block.caption ?? ""} placeholder="A line under the picture" onChange={(e) => set({ caption: e.target.value || undefined })} /></div>
    </div>
  );
}

function ImageProps({ block }: { block: ImageBlock }) {
  const updateBlock = useEditor((s) => s.updateBlock);
  const { templateId, email } = useDocEditorEnv();
  const [busy, setBusy] = useState(false);
  // An uploaded image's src is a private stored ref — not something to show or edit as a URL.
  const uploaded = !!block.src && storedFileSrc(block.src) !== block.src;

  const upload = async (file: File) => {
    const check = checkDocImage(file.size, new Uint8Array(await file.slice(0, 16).arrayBuffer()));
    if (!check.ok) { toast.error(check.error); return; }
    setBusy(true);
    try {
      const form = new FormData();
      form.set("file", file);
      if (templateId) form.set("templateId", templateId);
      const result = await uploadDocEditorImage(form);
      if (result.ok) updateBlock(block.id, { src: result.ref });
      else toast.error(result.error);
    } catch {
      toast.error("The upload failed. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Image">
      <div className={row}>
        <label className={`flex w-full cursor-pointer items-center justify-center rounded-md border border-slate-300 py-1.5 text-sm text-slate-700 hover:bg-slate-50 ${busy ? "pointer-events-none opacity-60" : ""}`}>
          {busy ? "Uploading…" : uploaded ? "Replace image" : "Upload image"}
          <input
            type="file"
            accept={DOC_IMAGE_ACCEPT}
            className="sr-only"
            disabled={busy}
            onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void upload(file); }}
          />
        </label>
        <p className="mt-1 text-[11px] text-slate-400">PNG, JPEG or WebP, up to 5 MB.</p>
      </div>
      <div className={row}><label className={lbl}>…or image URL</label><input className={inp} value={uploaded ? "" : block.src} placeholder={uploaded ? "Uploaded image — paste a URL to replace it" : "https://…"} onChange={(e) => updateBlock(block.id, { src: e.target.value })} /></div>
      <div className={row}><label className={lbl}>Alt text</label><input className={inp} value={block.alt} onChange={(e) => updateBlock(block.id, { alt: e.target.value })} /></div>
      <div className={row}><label className={lbl}>Width ({block.widthPct}%)</label><input type="range" min={10} max={100} className="w-full" value={block.widthPct} onChange={(e) => updateBlock(block.id, { widthPct: Number(e.target.value) }, false)} /></div>
      <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={block.rounded} onChange={(e) => updateBlock(block.id, { rounded: e.target.checked })} /> Rounded corners</label>
      {/* An email client decides how a picture is framed; a shape or a crop set here would not survive it. */}
      {!email && <ImageFraming block={block} />}
    </Section>
  );
}

// ── customer email blocks ───────────────────────────────────────────
/** What a button can open (or show): the message's own link or code fields. */
const BUTTON_FIELDS: Record<string, string> = {
  signing_link: "The signing link",
  review_link: "The Google review link",
  survey_link: "The survey link",
  code: "The code (shown large, no link)",
};

function EmailButtonProps({ block }: { block: EmailButtonBlock }) {
  const updateBlock = useEditor((s) => s.updateBlock);
  const { email } = useDocEditorEnv();
  const options = Object.keys(BUTTON_FIELDS).filter((f) => !email || email.kind === null || email.fields.includes(f));
  return (
    <Section title="Button">
      <div className={row}>
        <label className={lbl}>Opens</label>
        <select className={inp} value={block.token} onChange={(e) => updateBlock(block.id, { token: e.target.value })}>
          {options.map((f) => <option key={f} value={f}>{BUTTON_FIELDS[f]}</option>)}
          {!options.includes(block.token) && <option value={block.token}>{block.token} (not in this email)</option>}
        </select>
      </div>
      {block.token !== "code" && (
        <>
          <div className={row}><label className={lbl}>Label</label><input className={inp} value={block.label} onChange={(e) => updateBlock(block.id, { label: e.target.value }, false)} /></div>
          <div className={row}>
            <label className={lbl}>Style</label>
            <select className={inp} value={block.style} onChange={(e) => updateBlock(block.id, { style: e.target.value === "accent" ? "accent" : "dark" })}>
              <option value="dark">Button colour, with an accent arrow</option>
              <option value="accent">Brand colour</option>
            </select>
          </div>
        </>
      )}
      <p className="text-[11px] text-slate-400">An email is never sent without its link or code — if you delete this button, one is added back at the end.</p>
    </Section>
  );
}

function EmailFactsProps({ block }: { block: EmailFactsBlock }) {
  const updateBlock = useEditor((s) => s.updateBlock);
  const items = block.items;
  const set = (i: number, patch: Partial<EmailFactsBlock["items"][number]>) =>
    updateBlock(block.id, { items: items.map((item, j) => (j === i ? { ...item, ...patch } : item)) }, false);
  return (
    <Section title="Key figures">
      {items.map((item, i) => (
        <div key={i} className="mb-3 rounded-md border border-slate-200 p-2">
          <div className={row}><label className={lbl}>Label</label><input className={inp} value={item.label} onChange={(e) => set(i, { label: e.target.value })} /></div>
          <div className={row}><label className={lbl}>Value — a field like {"{{total}}"}</label><input className={inp} value={item.value} onChange={(e) => set(i, { value: e.target.value })} /></div>
          <div className={row}><label className={lbl}>Small line under it</label><input className={inp} value={item.sub} onChange={(e) => set(i, { sub: e.target.value })} /></div>
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-1.5 text-xs text-slate-600"><input type="checkbox" checked={item.highlight} onChange={(e) => set(i, { highlight: e.target.checked })} /> Dark card</label>
            <button type="button" className="text-xs text-red-500 hover:underline" onClick={() => updateBlock(block.id, { items: items.filter((_, j) => j !== i) })}>Remove</button>
          </div>
        </div>
      ))}
      {items.length < 3 && (
        <button type="button" className="w-full rounded-md border border-slate-300 py-1.5 text-sm text-slate-700 hover:bg-slate-50" onClick={() => updateBlock(block.id, { items: [...items, { label: "LABEL", value: "", sub: "", highlight: false }] })}>
          + Add a figure
        </button>
      )}
    </Section>
  );
}

/** A colour with a "standard" state: unset means the email's own default. */
function ColourRow({ label, value, standard, onChange }: { label: string; value: string | undefined; standard: string; onChange: (value: string) => void }) {
  return (
    <div className={row}>
      <label className={lbl}>{label}</label>
      <div className="flex items-center gap-2">
        <input type="color" value={value || standard} onChange={(e) => onChange(e.target.value)} className="h-8 flex-1 rounded border border-slate-300" />
        {value ? <button type="button" className="text-[11px] text-slate-500 underline hover:text-slate-700" onClick={() => onChange("")}>Standard</button> : null}
      </div>
    </div>
  );
}

const tick = "mb-1.5 flex items-center gap-2 text-sm text-slate-700";

function EmailHeaderProps({ block }: { block: EmailHeaderBlock }) {
  const updateBlock = useEditor((s) => s.updateBlock);
  return (
    <Section title="Header">
      <div className={row}>
        <label className={lbl}>Style</label>
        <select className={inp} value={block.style} onChange={(e) => updateBlock(block.id, { style: e.target.value as EmailHeaderBlock["style"] })}>
          <option value="panel">Logo panel (from your email signature)</option>
          <option value="bar">Full-width colour bar with your logo</option>
          <option value="plain">Logo only, no background</option>
        </select>
      </div>
      {block.style === "bar" && (
        <div className={row}><label className={lbl}>Bar colour</label><input type="color" value={block.background} onChange={(e) => updateBlock(block.id, { background: e.target.value })} className="h-8 w-full rounded border border-slate-300" /></div>
      )}
      {block.style !== "panel" && (
        <div className={row}><label className={lbl}>Logo size ({block.logoWidth}px wide)</label><input type="range" min={80} max={420} step={10} className="w-full" value={block.logoWidth} onChange={(e) => updateBlock(block.id, { logoWidth: Number(e.target.value) }, false)} /></div>
      )}
      <div className={row}>
        <label className={lbl}>Position</label>
        <select className={inp} value={block.align} onChange={(e) => updateBlock(block.id, { align: e.target.value === "center" ? "center" : "left" })}>
          <option value="left">Left</option>
          <option value="center">Centre</option>
        </select>
      </div>
      <p className="text-[11px] text-slate-400">
        {block.style === "panel"
          ? "The logo panel is the one from your email signature (Settings → My account → Email signature)."
          : "Your logo comes from Company profile. A white logo needs a dark bar behind it."}
      </p>
    </Section>
  );
}

function EmailSignatureProps({ block }: { block: EmailSignatureBlock }) {
  const updateBlock = useEditor((s) => s.updateBlock);
  const lines: [keyof Pick<EmailSignatureBlock, "showJobTitle" | "showCompany" | "showPhone" | "showEmail" | "showWebsite">, string][] = [
    ["showJobTitle", "Job title"],
    ["showCompany", "Company name"],
    ["showPhone", "Phone"],
    ["showEmail", "Email address"],
    ["showWebsite", "Website"],
  ];
  return (
    <Section title="Signature">
      <p className="mb-3 text-xs text-slate-500">
        Signed by whoever sends the email: their own name, job title, mobile and email (each person sets these under Settings → My account). Your company number is used when they have no mobile, and automatic messages are signed by your company.
      </p>
      <label className={lbl}>Lines to show</label>
      {lines.map(([key, label]) => (
        <label key={key} className={tick}><input type="checkbox" checked={block[key]} onChange={(e) => updateBlock(block.id, { [key]: e.target.checked })} /> {label}</label>
      ))}
    </Section>
  );
}

function EmailFooterProps({ block }: { block: EmailFooterBlock }) {
  const updateBlock = useEditor((s) => s.updateBlock);
  return (
    <Section title="Footer">
      <div className={row}>
        <label className={lbl}>Your own line (optional)</label>
        <input className={inp} value={block.note} placeholder="e.g. You're receiving this because you're a customer of ours." onChange={(e) => updateBlock(block.id, { note: e.target.value }, false)} />
      </div>
      <label className={tick}><input type="checkbox" checked={block.showCompany} onChange={(e) => updateBlock(block.id, { showCompany: e.target.checked })} /> Company name and address</label>
      <label className={`${tick} mb-3`}><input type="checkbox" checked={block.showContact} onChange={(e) => updateBlock(block.id, { showContact: e.target.checked })} /> Phone, email and website</label>
      <div className={row}>
        <label className={lbl}>Alignment</label>
        <select className={inp} value={block.align} onChange={(e) => updateBlock(block.id, { align: e.target.value as EmailFooterBlock["align"] })}>
          <option value="left">Left</option>
          <option value="center">Centre</option>
          <option value="right">Right</option>
        </select>
      </div>
      <div className={row}><label className={lbl}>Text colour</label><input type="color" value={block.color} onChange={(e) => updateBlock(block.id, { color: e.target.value })} className="h-8 w-full rounded border border-slate-300" /></div>
      <ColourRow label="Background" value={block.background} standard="#ffffff" onChange={(background) => updateBlock(block.id, { background })} />
      <p className="text-[11px] text-slate-400">The company details themselves come from Company profile.</p>
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
      <Section title="Table style"><TableStyleControls value={block.tableStyle} onChange={(tableStyle) => updateBlock(block.id, { tableStyle })} /></Section>
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
        <p className="text-[11px] leading-snug text-slate-500">
          Merge fields work here, e.g. <code>{"{{quote.validUntil}}"}</code> (the quote&apos;s expiry date),{" "}
          <code>{"{{quote.validDays}}"}</code> (days it is valid for) and <code>{"{{quote.vatRate}}"}</code> (its VAT rate).
        </p>
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
      {/* The showcase and classic looks are drawn to fixed measurements the page layout (and its overflow onto a second page) depends on. */}
      {!block.look || block.look === "standard" ? (
        <Section title="Table style"><TableStyleControls value={block.tableStyle} onChange={(tableStyle) => updateBlock(block.id, { tableStyle })} /></Section>
      ) : null}
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
                {(!block.look || block.look === "standard") && (
                  <input
                    type="number" min={5} max={90} step={5} className="w-16 rounded border border-slate-300 px-1 text-xs" title="Width, as a percent of the table. Empty = sized by its content." aria-label={`Width of column ${i + 1}, percent`} placeholder="auto"
                    value={c.widthPct ?? ""}
                    onChange={(e) => setCols(block.columns.map((x, j) => { if (j !== i) return x; const { widthPct: _w, ...rest } = x; void _w; const n = Number(e.target.value); return e.target.value && n > 0 ? { ...rest, widthPct: Math.min(90, n) } : rest; }))}
                  />
                )}
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
/**
 * The document's own style: a ready-made type setting, then the pieces of it,
 * then the two brand colours. Changing a colour repaints every block drawn in
 * the old one (docStyles.recolour) — it used to change link text and nothing else.
 */
function DocumentStyleSection() {
  const style = useEditor((s) => s.doc!.style);
  const setStyle = useEditor((s) => s.setStyle);
  const commit = useEditor((s) => s.commit);
  const preset = activePreset(style);
  const size = style.bodySize ?? 11;
  const spacing = style.lineHeight ?? 1.5;
  return (
    <Section title="Style">
      <label className={lbl}>Ready-made</label>
      <div className="mb-3 grid grid-cols-2 gap-1.5">
        {STYLE_PRESETS.map((p) => (
          <button
            key={p.key} type="button" title={p.hint} aria-pressed={preset === p.key} onClick={() => setStyle({ ...p.style })}
            className={`rounded-md border px-2 py-1.5 text-left text-xs ${preset === p.key ? "border-orange-400 bg-orange-50 text-orange-700" : "border-slate-300 text-slate-700 hover:bg-slate-50"}`}
          >
            <span className="block font-medium" style={{ fontFamily: (p.style.headingFont ?? p.style.fontFamily) === "serif" ? "Georgia,serif" : undefined }}>{p.name}</span>
            <span className="block text-[10px] leading-tight text-slate-500">{p.hint}</span>
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div><label className={lbl}>Text</label>
          <select className={inp} value={style.fontFamily} onChange={(e) => setStyle({ fontFamily: e.target.value as DocStyle["fontFamily"] })}><option value="sans">Sans</option><option value="serif">Serif</option><option value="mono">Mono</option></select>
        </div>
        <div><label className={lbl}>Headings</label>
          <select className={inp} value={style.headingFont ?? ""} onChange={(e) => setStyle({ headingFont: (e.target.value || undefined) as DocStyle["headingFont"] })}><option value="">Same as text</option><option value="sans">Sans</option><option value="serif">Serif</option><option value="mono">Mono</option></select>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <div><label className={lbl}>Text size ({size}pt)</label><input type="range" min={8} max={14} step={0.5} className="w-full" value={size} onChange={(e) => setStyle({ bodySize: Number(e.target.value) })} /></div>
        <div><label className={lbl}>Line spacing ({spacing})</label><input type="range" min={1.1} max={2} step={0.05} className="w-full" value={spacing} onChange={(e) => setStyle({ lineHeight: Number(e.target.value) })} /></div>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <div><label className={lbl}>Accent</label><input type="color" aria-label="Accent colour" value={style.accent} onChange={(e) => commit((d) => recolour(d, "accent", e.target.value))} className="h-8 w-full rounded border border-slate-300" /></div>
        <div><label className={lbl}>Dark</label><input type="color" aria-label="Dark colour — bands, table headings, heading text" value={style.ink} onChange={(e) => commit((d) => recolour(d, "ink", e.target.value))} className="h-8 w-full rounded border border-slate-300" /></div>
        <div><label className={lbl}>Text</label><input type="color" aria-label="Text colour" value={style.textColor ?? "#1e293b"} onChange={(e) => setStyle({ textColor: e.target.value })} className="h-8 w-full rounded border border-slate-300" /></div>
      </div>
      <p className="mt-2 text-[11px] text-slate-400">Accent and Dark repaint every block drawn in the old colour. A block you coloured differently is left alone. Blocks with their own designed type sizes (cards, bands, tables) keep them — use a block&apos;s Text size to change one.</p>
    </Section>
  );
}

function DocumentProps() {
  const doc = useEditor((s) => s.doc)!;
  const setStyle = useEditor((s) => s.setStyle);
  const setTitle = useEditor((s) => s.setTitle);
  const addRecipient = useEditor((s) => s.addRecipient);
  const updateRecipient = useEditor((s) => s.updateRecipient);
  const removeRecipient = useEditor((s) => s.removeRecipient);
  const { email } = useDocEditorEnv();
  // An email has no page size, margins or signers: its width is the 600px mail apps show.
  if (email) {
    return (
      <Section title={email.kind ? "Email" : "Email frame"}>
        <div className={row}><label className={lbl}>Name</label><input className={inp} value={doc.title} onChange={(e) => setTitle(e.target.value)} /></div>
        <p className="text-xs text-slate-500">
          {email.kind
            ? "Click a block to change it, or drag new ones in from the left. The subject line is above the email. Preview shows it exactly as your customer receives it, in your frame."
            : "The header, signature and footer around every customer email. Each email's own content appears in the message slot."}
        </p>
        {email.kind ? (
          <p className="mt-2 text-xs text-slate-500">
            The header, signature and footer around it are the shared frame — click them on the email to style them.
          </p>
        ) : (
          <>
            <p className="mb-3 mt-2 text-xs text-slate-500">Click the header, signature or footer on the email to style it. These colours apply to every customer email.</p>
            {([
              ["pageColor", "Page behind the email", "#f3f4f6"],
              ["cardColor", "Email background", "#ffffff"],
              ["buttonColor", "Buttons", "#0b0f19"],
              ["accentColor", "Accent — links, the button's arrow, highlighted figures", cssColor(email.brand.accent, "#f1603c")],
            ] as const).map(([key, label, standard]) => (
              <ColourRow
                key={key} label={label} value={doc.email?.[key]} standard={standard}
                onChange={(value) => useEditor.getState().commit((d) => ({ ...d, email: { subject: "", ...d.email, [key]: value } }))}
              />
            ))}
            <p className="text-[11px] text-slate-400">Your logo and company details come from Company profile.</p>
          </>
        )}
      </Section>
    );
  }
  return (
    <>
      <Section title="Document">
        <div className={row}><label className={lbl}>Title</label><input className={inp} value={doc.title} onChange={(e) => setTitle(e.target.value)} /></div>
        <div className="grid grid-cols-2 gap-2">
          <div><label className={lbl}>Page size</label>
            <select className={inp} value={doc.style.pageSize} onChange={(e) => setStyle({ pageSize: e.target.value as "A4" | "Letter" })}><option value="A4">A4</option><option value="Letter">Letter</option></select>
          </div>
          <div><label className={lbl}>Margin ({doc.style.margin}px)</label><input type="range" min={0} max={96} className="w-full" value={doc.style.margin} onChange={(e) => setStyle({ margin: Number(e.target.value) })} /></div>
        </div>
      </Section>
      <DocumentStyleSection />
      <RunningSection />
      <Section title="Recipients">
        <div className="space-y-2">
          {doc.recipients.map((r) => (
            <div key={r.id} className="rounded-md border border-slate-200 p-2">
              <div className="mb-1 flex items-center gap-2">
                <span className="h-3 w-3 rounded-full" style={{ background: r.color }} />
                {/* Who this is, not what they are called. A template is reused
                    across records, so the name and email belong to the record —
                    only the party is knowable while designing. */}
                <select
                  className={inp}
                  value={r.party}
                  onChange={(e) => updateRecipient(r.id, { party: e.target.value as Recipient["party"] })}
                >
                  <option value="denago">Our team (whoever sends it)</option>
                  <option value="customer">The customer</option>
                  <option value="custom">Someone specific…</option>
                </select>
              </div>
              {r.party === "custom" ? (
                <>
                  <input className={`${inp} mb-1`} value={r.name} placeholder="Name" onChange={(e) => updateRecipient(r.id, { name: e.target.value })} />
                  <input className={`${inp} mb-1`} value={r.email} placeholder="Email" onChange={(e) => updateRecipient(r.id, { email: e.target.value })} />
                </>
              ) : (
                <p className="mb-1 text-[11px] text-slate-500">
                  {r.party === "denago"
                    ? "Filled in from the sender when the document goes out — and their saved signature is applied in one click."
                    : "Filled in from the quote's contact when the document goes out."}
                </p>
              )}
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

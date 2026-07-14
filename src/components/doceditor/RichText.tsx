"use client";

import { Plate, PlateContent, PlateElement, createPlatePlugin, usePlateEditor } from "platejs/react";
import { BasicBlocksPlugin, BasicMarksPlugin } from "@platejs/basic-nodes/react";
import { plateToHtmlBody, prettyToken } from "@/lib/docbuilder/plateSerialize";
import { useEditor } from "@/lib/doceditor/store";
import type { TextBlock, HeadingBlock } from "@/lib/doceditor/model";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Inline, void "merge field" element — rendered as a coloured pill in the editor. */
function MergeFieldElement(props: any) {
  const token = props.element?.token as string;
  return (
    <PlateElement {...props} as="span">
      <span
        contentEditable={false}
        style={{ background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 4, padding: "0 5px", margin: "0 1px", color: "#c2410c", fontSize: "0.9em", whiteSpace: "nowrap" }}
      >
        {prettyToken(token)}
      </span>
      {props.children}
    </PlateElement>
  );
}

const MergeFieldPlugin = createPlatePlugin({
  key: "mergeField",
  node: { isElement: true, isInline: true, isVoid: true, component: MergeFieldElement },
});

const VARIABLES: { group: string; fields: string[] }[] = [
  { group: "Customer", fields: ["customer.name", "customer.phone", "customer.email", "customer.address"] },
  { group: "Quotation", fields: ["quote.number", "quote.date", "quote.validUntil", "quote.subtotal", "quote.vat", "quote.total", "vehicle", "preparedBy"] },
  { group: "Job card", fields: ["jobcard.number", "jobcard.status", "jobcard.total", "vehicle.reg", "technician"] },
];
const EMPTY = [{ type: "p", children: [{ text: "" }] }];

/** Read-only render for inactive blocks — no Plate instance mounted. */
export function ReadOnlyRichText({ value, muted }: { value: unknown[]; muted?: boolean }) {
  const html = plateToHtmlBody(Array.isArray(value) ? (value as any) : [], null);
  return (
    <div
      className="doc-richtext"
      dangerouslySetInnerHTML={{ __html: html || `<p style="color:#94a3b8">${muted ? "Empty text — click to edit" : ""}</p>` }}
    />
  );
}

/** The live Plate editor — mounted ONLY for the currently active text/heading block. */
export function ActiveRichText({ block }: { block: TextBlock | HeadingBlock }) {
  const updateBlock = useEditor((s) => s.updateBlock);
  const editor = usePlateEditor({
    plugins: [BasicBlocksPlugin, BasicMarksPlugin, MergeFieldPlugin],
    value: (Array.isArray(block.value) && block.value.length ? block.value : EMPTY) as any,
  });

  const mark = (key: string) => { try { (editor.tf as any)[key]?.toggle?.(); } catch {} };
  const setBlock = (type: string) => {
    try { const ns = (editor.tf as any)[type]; if (ns?.toggle) ns.toggle(); else (editor.tf as any).toggleBlock?.({ type }); } catch {}
  };
  const insertVar = (t: string) => {
    if (!t) return;
    try {
      editor.tf.focus();
      (editor.tf as any).insertNodes({ type: "mergeField", token: t, children: [{ text: "" }] });
    } catch { try { (editor.tf as any).insertText(`{{${t}}}`); } catch {} }
  };

  const tb = "h-7 min-w-7 rounded px-1.5 text-xs text-slate-700 hover:bg-slate-100";
  return (
    <div onMouseDown={(e) => e.stopPropagation()}>
      <div className="doc-float-toolbar mb-1 flex flex-wrap items-center gap-0.5 rounded-md border border-slate-200 bg-white px-1 py-1 shadow-sm">
        <button type="button" onMouseDown={(e) => { e.preventDefault(); mark("bold"); }} className={`${tb} font-bold`}>B</button>
        <button type="button" onMouseDown={(e) => { e.preventDefault(); mark("italic"); }} className={`${tb} italic`}>I</button>
        <button type="button" onMouseDown={(e) => { e.preventDefault(); mark("underline"); }} className={`${tb} underline`}>U</button>
        <button type="button" onMouseDown={(e) => { e.preventDefault(); mark("strikethrough"); }} className={`${tb} line-through`}>S</button>
        <span className="mx-0.5 h-4 w-px bg-slate-200" />
        <button type="button" onMouseDown={(e) => { e.preventDefault(); setBlock("h1"); }} className={tb}>H1</button>
        <button type="button" onMouseDown={(e) => { e.preventDefault(); setBlock("h2"); }} className={tb}>H2</button>
        <button type="button" onMouseDown={(e) => { e.preventDefault(); setBlock("p"); }} className={tb}>¶</button>
        <button type="button" onMouseDown={(e) => { e.preventDefault(); setBlock("blockquote"); }} className={tb}>❝</button>
        <span className="mx-0.5 h-4 w-px bg-slate-200" />
        <select
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => { insertVar(e.target.value); e.currentTarget.value = ""; }}
          defaultValue=""
          className="h-7 rounded border border-slate-200 bg-white px-1 text-xs text-slate-700"
          title="Insert a CRM variable"
        >
          <option value="">＋ variable</option>
          {VARIABLES.map((g) => (
            <optgroup key={g.group} label={g.group}>
              {g.fields.map((f) => <option key={f} value={f}>{`{{${f}}}`}</option>)}
            </optgroup>
          ))}
        </select>
      </div>
      <div className="doc-richtext rounded outline-none ring-2 ring-orange-400/40">
        <Plate editor={editor} onChange={({ value: v }: any) => updateBlock(block.id, { value: v } as any, false)}>
          <PlateContent className="min-h-6 px-1 outline-none" />
        </Plate>
      </div>
    </div>
  );
}

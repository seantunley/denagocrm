"use client";

import { useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import { useEditor } from "@/lib/doceditor/store";
import { newBlock, newOverlayField } from "@/lib/doceditor/factory";
import { showcaseQuoteTemplate } from "@/lib/doceditor/standardTemplates";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import type { BlockType, OverlayField } from "@/lib/doceditor/model";
import type { DragData } from "./DndController";
import { LibraryTab } from "./LibraryTab";
import { useDocEditorEnv } from "./EditorContext";

const CONTENT: { type: BlockType; label: string; icon: string }[] = [
  { type: "text", label: "Text", icon: "¶" },
  { type: "heading", label: "Heading", icon: "H" },
  { type: "image", label: "Image", icon: "🖼" },
  { type: "pricing", label: "Pricing table", icon: "R" },
  { type: "table", label: "Table", icon: "▦" },
  { type: "divider", label: "Divider", icon: "―" },
  { type: "spacer", label: "Spacer", icon: "↕" },
  { type: "pageBreak", label: "Page break", icon: "⤓" },
  { type: "conditional", label: "Conditional", icon: "⌥" },
];

const BRANDED: { type: BlockType; label: string; icon: string }[] = [
  { type: "banner", label: "Brand banner", icon: "▬" },
  { type: "infoCard", label: "Info card", icon: "🪪" },
  { type: "lineItems", label: "Line items (bound)", icon: "≣" },
  { type: "statementLines", label: "Statement lines (bound)", icon: "☰" },
  { type: "totalBand", label: "Total band", icon: "∑" },
  { type: "terms", label: "Terms", icon: "§" },
  { type: "handoverChecklist", label: "Handover checklist (bound)", icon: "☑" },
  { type: "footer", label: "Footer", icon: "‗" },
];

/** Ready-made sections. Three of them are one block (a details grid) with different starting content. */
const SECTIONS: { type: BlockType; label: string; icon: string; preset?: string }[] = [
  { type: "detailsGrid", label: "Label / value grid", icon: "▤" },
  { type: "detailsGrid", preset: "spec", label: "Specification grid", icon: "▦" },
  { type: "detailsGrid", preset: "banking", label: "Banking details", icon: "🏦" },
  { type: "paymentSchedule", label: "Payment schedule", icon: "①" },
  { type: "comparison", label: "Comparison table", icon: "⇄" },
  { type: "callout", label: "Callout", icon: "❕" },
  { type: "gallery", label: "Photo gallery", icon: "▥" },
  { type: "qr", label: "QR code / link", icon: "▣" },
];

const SHOWCASE: { type: BlockType; label: string; icon: string }[] = [
  { type: "showcaseHeader", label: "Header band", icon: "▀" },
  { type: "infoStrip", label: "Info strip", icon: "⋯" },
  { type: "vehicleShowcase", label: "Vehicle showcase (bound)", icon: "🚙" },
  { type: "totalsBox", label: "Totals box", icon: "∑" },
  { type: "acceptance", label: "Acceptance card", icon: "✍" },
  { type: "footerBand", label: "Footer band", icon: "▄" },
];

/** Swap the whole document for the showcase quotation layout. Undoable; nothing is saved until the owner saves/publishes. */
function ShowcaseLayoutButton() {
  const commit = useEditor((s) => s.commit);
  return (
    <ConfirmActionDialog
      trigger={
        <button type="button" className="w-full rounded-lg border border-orange-200 bg-orange-50 px-2.5 py-2 text-left text-sm text-orange-700 hover:border-orange-300">
          ✨ Replace with showcase quotation layout
        </button>
      }
      title="Use the showcase quotation layout?"
      description="This replaces every page of this document with the showcase layout. Undo brings it back, and nothing changes for customers until you save and publish."
      confirmLabel="Replace layout"
      onConfirm={() => commit((doc) => ({ ...showcaseQuoteTemplate(), title: doc.title }))}
    />
  );
}

const FIELDS: { kind: OverlayField["kind"]; label: string; icon: string }[] = [
  { kind: "signature", label: "Signature", icon: "✍" },
  { kind: "initials", label: "Initials", icon: "AB" },
  { kind: "date", label: "Date", icon: "📅" },
  { kind: "text", label: "Text field", icon: "﹍" },
  { kind: "checkbox", label: "Checkbox", icon: "☑" },
  { kind: "dropdown", label: "Dropdown", icon: "▾" },
];

const TABS = ["Content", "Fields", "Library"] as const;

// The Library tab — search, categories, previews and whole sections — lives in ./LibraryTab.

function ContentItem({ type, label, icon, preset }: { type: BlockType; label: string; icon: string; preset?: string }) {
  const appendToPage = useEditor((s) => s.appendToPage);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `new-${type}${preset ? `-${preset}` : ""}`, data: { source: "new", blockType: type, preset } satisfies DragData,
  });
  return (
    <button
      ref={setNodeRef} {...listeners} {...attributes}
      type="button"
      // On the page the person is working on. It used to be the last page, always.
      onClick={() => { const { activePage, doc } = useEditor.getState(); appendToPage(Math.min(activePage, Math.max(0, (doc?.pages.length ?? 1) - 1)), newBlock(type, preset)); }}
      title="Drag onto the page, or click to add at the end of the page you are working on"
      className={`flex cursor-grab items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-left text-sm text-slate-700 hover:border-orange-300 hover:bg-orange-50 ${isDragging ? "opacity-40" : ""}`}
    >
      <span className="grid h-6 w-6 place-items-center rounded bg-slate-100 text-xs">{icon}</span>
      {label}
    </button>
  );
}

/** A customer email's blocks — only what mail apps can show (doceditor/emailRender.ts). */
const EMAIL_CONTENT: { type: BlockType; label: string; icon: string }[] = [
  { type: "heading", label: "Headline", icon: "H" },
  { type: "text", label: "Text", icon: "¶" },
  { type: "emailButton", label: "Button (or code)", icon: "▭" },
  { type: "emailFacts", label: "Key figures", icon: "▦" },
  { type: "image", label: "Image", icon: "🖼" },
  { type: "divider", label: "Divider", icon: "―" },
  { type: "spacer", label: "Spacer", icon: "↕" },
];
const EMAIL_FRAME: { type: BlockType; label: string; icon: string }[] = [
  { type: "emailHeader", label: "Logo panel", icon: "▀" },
  { type: "emailBody", label: "Message slot", icon: "✉" },
  { type: "emailSignature", label: "Signature", icon: "✍" },
  { type: "emailFooter", label: "Footer", icon: "▄" },
];

export function Palette() {
  const { email } = useDocEditorEnv();
  if (email) return <EmailPalette frame={email.kind === null} />;
  return <DocumentPalette />;
}

function EmailPalette({ frame }: { frame: boolean }) {
  return (
    <div className="flex-1 space-y-2 overflow-y-auto p-2">
      <p className="px-1 text-[11px] text-slate-400">
        {frame
          ? "The frame every customer email shares. Drag to reorder; the message slot is where each email's own content goes."
          : "Drag onto the email, or click to add at the end. Drop beside a block for two columns (they stack on phones)."}
      </p>
      <div className="grid grid-cols-1 gap-1.5">
        {(frame ? [...EMAIL_FRAME, ...EMAIL_CONTENT] : EMAIL_CONTENT).map((c) => <ContentItem key={c.type} {...c} />)}
      </div>
    </div>
  );
}

function DocumentPalette() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Content");
  const addField = useEditor((s) => s.addField);
  const selectField = useEditor((s) => s.selectField);

  const addOverlay = (kind: OverlayField["kind"]) => {
    const field = newOverlayField(kind);
    // On the page the person is working on. It used to be page 1, always — a
    // signature for page 3 had to be made on page 1 and could not be dragged across.
    const { activePage, doc } = useEditor.getState();
    addField(Math.min(activePage, Math.max(0, (doc?.pages.length ?? 1) - 1)), field);
    selectField(field.id);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex gap-1 border-b border-slate-200 px-2 pt-2">
        {TABS.map((t) => (
          <button
            key={t} type="button" onClick={() => setTab(t)}
            className={`rounded-t-md px-3 py-1.5 text-xs font-medium ${tab === t ? "bg-white text-slate-800 shadow-[inset_0_-2px_0_#f97316]" : "text-slate-400 hover:text-slate-600"}`}
          >{t}</button>
        ))}
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-2">
        {tab === "Content" ? (
          <>
            <p className="px-1 text-[11px] text-slate-400">Drag onto the page — drop above, below, or beside another block to build columns.</p>
            <div className="grid grid-cols-1 gap-1.5">
              {CONTENT.map((c) => <ContentItem key={c.type} {...c} />)}
            </div>
            <p className="px-1 pt-2 text-[11px] font-medium text-slate-400">Branded (quote/proposal)</p>
            <div className="grid grid-cols-1 gap-1.5">
              {BRANDED.map((c) => <ContentItem key={c.type} {...c} />)}
            </div>
            <p className="px-1 pt-2 text-[11px] font-medium text-slate-400">Sections</p>
            <div className="grid grid-cols-1 gap-1.5">
              {SECTIONS.map((c) => <ContentItem key={`${c.type}-${c.preset ?? ""}`} {...c} />)}
            </div>
            <p className="px-1 pt-2 text-[11px] font-medium text-slate-400">Showcase quotation</p>
            <ShowcaseLayoutButton />
            <div className="grid grid-cols-1 gap-1.5">
              {SHOWCASE.map((c) => <ContentItem key={c.type} {...c} />)}
            </div>
          </>
        ) : tab === "Fields" ? (
          <>
            <p className="px-1 text-[11px] text-slate-400">Click to add a field, then drag it anywhere on the page and assign a recipient.</p>
            <div className="grid grid-cols-2 gap-1.5">
              {FIELDS.map((f) => (
                <button
                  key={f.kind} type="button" onClick={() => addOverlay(f.kind)}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-2 text-left text-xs text-slate-700 hover:border-blue-300 hover:bg-blue-50"
                >
                  <span className="grid h-5 w-5 place-items-center rounded bg-slate-100 text-[10px]">{f.icon}</span>
                  {f.label}
                </button>
              ))}
            </div>
          </>
        ) : (
          <LibraryTab />
        )}
      </div>
    </div>
  );
}

"use client";

import { useEditorState, type Editor } from "@tiptap/react";
import { useRef, useState, type ReactNode } from "react";
import { EmailButtonDialog } from "@/components/RichTextEditor";
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, Eraser, Heading2, Highlighter, Palette, ChevronDown, ImageIcon, IndentDecrease, IndentIncrease,
  Italic, Link2, List, ListOrdered, Minus, MoveVertical, RectangleHorizontal, Strikethrough, Table2, Underline, Unlink,
} from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { TextPromptDialog } from "@/components/TextPromptDialog";
import { emailReadyImage } from "@/components/emailBlockStyle";

/**
 * The email composer's ribbon, laid out the way Outlook's Message tab is (Sean,
 * 2026-10-15: "Can we not build this as our email editor? I find this one is so
 * hard to work with"): Basic text, then Insert, each a labelled group.
 *
 * Every control writes something a mail client keeps — inline styles, plain
 * tags — so what is set here is what the customer sees. The typefaces are the
 * ones every inbox has; a web font would fall back to something else anyway.
 */

export const EMAIL_FONTS = [
  { label: "Arial", value: "Arial, Helvetica, sans-serif" },
  { label: "Calibri", value: "Calibri, Carlito, Arial, sans-serif" },
  { label: "Georgia", value: "Georgia, 'Times New Roman', serif" },
  { label: "Times New Roman", value: "'Times New Roman', Times, serif" },
  { label: "Verdana", value: "Verdana, Geneva, sans-serif" },
  { label: "Tahoma", value: "Tahoma, Verdana, sans-serif" },
  { label: "Trebuchet MS", value: "'Trebuchet MS', Arial, sans-serif" },
  { label: "Courier New", value: "'Courier New', Courier, monospace" },
] as const;
export const EMAIL_SIZES = ["8pt", "9pt", "10pt", "11pt", "12pt", "14pt", "16pt", "18pt", "20pt", "24pt", "28pt", "36pt"] as const;
const TEXT_COLOURS = ["#000000", "#1e293b", "#ea580c", "#dc2626", "#2563eb", "#059669", "#7c3aed", "#6b7280"];
const HIGHLIGHTS = ["#fef08a", "#bbf7d0", "#bfdbfe", "#fecaca", "#fed7aa"];

function Tool({ title, active, onClick, children, disabled }: { title: string; active?: boolean; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      // Keep the cursor where it is in the message: a mousedown on a button would otherwise take the focus.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={`focus-visible:ring-2 focus-visible:ring-primary grid h-9 min-w-9 place-items-center rounded-md px-1.5 text-slate-200 transition-colors disabled:opacity-40 ${active ? "bg-orange-600/90 text-white" : "hover:bg-white/10"}`}
    >
      {children}
    </button>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 max-w-full flex-col justify-between gap-1 border-r border-white/10 px-2 last:border-r-0">
      <div className="flex flex-wrap items-center gap-0.5">{children}</div>
      <span className="sr-only">{label}</span>
    </div>
  );
}

export default function EmailRibbon({
  editor,
  insert,
  options,
  onImageProblem,
}: {
  editor: Editor | null;
  /** The composer's own Insert controls — attach a file, a library document, a quote. */
  insert?: ReactNode;
  /** The composer's options — template, banner. */
  options?: ReactNode;
  onImageProblem?: (message: string) => void;
}) {
  const pictureRef = useRef<HTMLInputElement>(null);
  const [buttonOpen, setButtonOpen] = useState(false);
  // Re-render as the cursor moves, so the buttons show what is under it.
  const at = useEditorState({
    editor,
    selector: ({ editor: e }) => (e
      ? {
          bold: e.isActive("bold"), italic: e.isActive("italic"), underline: e.isActive("underline"), strike: e.isActive("strike"),
          heading: e.isActive("heading", { level: 2 }), bullet: e.isActive("bulletList"), ordered: e.isActive("orderedList"), link: e.isActive("link"), table: e.isActive("table"), button: e.isActive("emailButton"),
          font: String(e.getAttributes("textStyle").fontFamily ?? ""), size: String(e.getAttributes("textStyle").fontSize ?? ""),
          align: String(e.getAttributes("paragraph").textAlign ?? e.getAttributes("heading").textAlign ?? "left"),
        }
      : null),
  });
  if (!editor || !at) return <div className="h-12 border-b border-border bg-card" />;
  const run = () => editor.chain().focus();

  return (
    // Wraps rather than scrolls: a group pushed off the right-hand edge was a group nobody found (Options, at 1500px).
    <div className="flex flex-wrap items-center gap-y-1 border-b border-border bg-card px-1 py-2" role="toolbar" aria-label="Formatting">
      <Group label="Basic text">
        <select
          aria-label="Font"
          className="h-8 w-36 rounded-md border border-white/10 bg-slate-900 px-2 text-xs text-slate-100"
          value={EMAIL_FONTS.find((font) => font.value === at.font)?.value ?? ""}
          onChange={(event) => (event.target.value ? run().setFontFamily(event.target.value).run() : run().unsetFontFamily().run())}
        >
          <option value="">Arial</option>
          {EMAIL_FONTS.map((font) => <option key={font.label} value={font.value} style={{ fontFamily: font.value }}>{font.label}</option>)}
        </select>
        <select
          aria-label="Size"
          className="h-8 w-20 rounded-md border border-white/10 bg-slate-900 px-2 text-xs text-slate-100"
          value={(EMAIL_SIZES as readonly string[]).includes(at.size) ? at.size : ""}
          onChange={(event) => (event.target.value ? run().setFontSize(event.target.value).run() : run().unsetFontSize().run())}
        >
          <option value="">11</option>
          {EMAIL_SIZES.map((size) => <option key={size} value={size}>{size.replace("pt", "")}</option>)}
        </select>
        <span className="mx-1 h-5 w-px bg-white/10" />
        <Tool title="Bold (Ctrl+B)" active={at.bold} onClick={() => run().toggleBold().run()}><Bold className="size-4" /></Tool>
        <Tool title="Italic (Ctrl+I)" active={at.italic} onClick={() => run().toggleItalic().run()}><Italic className="size-4" /></Tool>
        <span className="mx-1 h-5 w-px bg-white/10" />
        <Popover><PopoverTrigger asChild><button type="button" aria-label="Text colour and highlight" className="grid size-9 place-items-center rounded-md text-slate-200 hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-primary"><Palette className="size-4" /></button></PopoverTrigger><PopoverContent className="w-64 space-y-3" align="start"><p className="text-xs font-medium">Text colour & highlight</p>
        <span className="flex items-center gap-0.5" title="Text colour">
          {TEXT_COLOURS.map((colour) => (
            <button key={colour} type="button" aria-label={`Text colour ${colour}`} onMouseDown={(event) => event.preventDefault()} onClick={() => run().setColor(colour).run()} className="size-6 rounded-sm border border-white/20" style={{ backgroundColor: colour }} />
          ))}
        </span>
        <span className="ml-1 flex items-center gap-0.5" title="Highlight">
          <Highlighter className="size-3.5 text-slate-400" />
          {HIGHLIGHTS.map((colour) => (
            <button key={colour} type="button" aria-label={`Highlight ${colour}`} onMouseDown={(event) => event.preventDefault()} onClick={() => run().setBackgroundColor(colour).run()} className="size-6 rounded-sm border border-white/20" style={{ backgroundColor: colour }} />
          ))}
          <button type="button" aria-label="No highlight" title="No highlight" onMouseDown={(event) => event.preventDefault()} onClick={() => run().unsetBackgroundColor().run()} className="size-6 rounded-sm border border-white/30 text-[9px] leading-none text-slate-300">✕</button>
        </span>
        </PopoverContent></Popover>
        <Tool title="Bullets" active={at.bullet} onClick={() => run().toggleBulletList().run()}><List className="size-4" /></Tool>
        <Tool title="Numbering" active={at.ordered} onClick={() => run().toggleOrderedList().run()}><ListOrdered className="size-4" /></Tool>
      </Group>
      <Group label="Link and attachments">
        <TextPromptDialog
          title="Insert link"
          description="Paste the full web address."
          label="Link"
          defaultValue={editor.getAttributes("link").href ?? "https://"}
          submitLabel="Apply link"
          onSubmit={(url) => { run().setLink({ href: url }).run(); }}
          trigger={<span><Tool title="Link" active={at.link} onClick={() => undefined}><Link2 className="size-4" /></Tool></span>}
        />
        {at.link && <Tool title="Remove link" onClick={() => run().unsetLink().run()}><Unlink className="size-4" /></Tool>}
        {insert}
      </Group>
      <details className="group/format basis-full sm:basis-auto">
        <summary className="flex min-h-9 cursor-pointer list-none items-center gap-1.5 rounded-md px-3 text-xs text-muted-foreground hover:text-foreground">More formatting<ChevronDown className="size-3.5 group-open/format:rotate-180" /></summary>
        <div className="flex flex-wrap gap-y-2 py-2">
      <Group label="Paragraph">
        <Tool title="Underline (Ctrl+U)" active={at.underline} onClick={() => run().toggleUnderline().run()}><Underline className="size-4" /></Tool>
        <Tool title="Strikethrough" active={at.strike} onClick={() => run().toggleStrike().run()}><Strikethrough className="size-4" /></Tool>

        <Tool title="Heading" active={at.heading} onClick={() => run().toggleHeading({ level: 2 }).run()}><Heading2 className="size-4" /></Tool>
        <Tool title="Decrease indent (Ctrl+[)" onClick={() => run().outdentEmailBlock().run()}><IndentDecrease className="size-4" /></Tool>
        <Tool title="Increase indent (Ctrl+])" onClick={() => run().indentEmailBlock().run()}><IndentIncrease className="size-4" /></Tool>
        <span className="mx-1 h-5 w-px bg-white/10" />
        <Tool title="Align left" active={at.align === "left"} onClick={() => run().setEmailAlign("left").run()}><AlignLeft className="size-4" /></Tool>
        <Tool title="Centre" active={at.align === "center"} onClick={() => run().setEmailAlign("center").run()}><AlignCenter className="size-4" /></Tool>
        <Tool title="Align right" active={at.align === "right"} onClick={() => run().setEmailAlign("right").run()}><AlignRight className="size-4" /></Tool>
        <Tool title="Justify" active={at.align === "justify"} onClick={() => run().setEmailAlign("justify").run()}><AlignJustify className="size-4" /></Tool>
        <Tool title="Clear formatting" onClick={() => run().clearNodes().unsetAllMarks().run()}><Eraser className="size-4" /></Tool>
      </Group>

      <Group label="Insert">
        <Tool title="Picture from your computer (or paste one with Ctrl+V)" onClick={() => pictureRef.current?.click()}><ImageIcon className="size-4" /></Tool>
        <input
          ref={pictureRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          className="hidden"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            const src = await emailReadyImage(file);
            if (src) run().setImage({ src }).run();
            else onImageProblem?.(`“${file.name}” couldn't be added — use a PNG, JPEG, GIF or WebP image under about 2.5 MB.`);
          }}
        />
        <Tool title="Table" active={at.table} onClick={() => run().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}><Table2 className="size-4" /></Tool>
        {at.table && (
          <>
            <Tool title="Add a row" onClick={() => run().addRowAfter().run()}><span className="text-xs">+Row</span></Tool>
            <Tool title="Add a column" onClick={() => run().addColumnAfter().run()}><span className="text-xs">+Col</span></Tool>
            <Tool title="Delete the table" onClick={() => run().deleteTable().run()}><span className="text-xs">✕Tbl</span></Tool>
          </>
        )}
        <Tool title="Button (a link styled as a button, safe in every mail client)" active={at.button} onClick={() => setButtonOpen(true)}><RectangleHorizontal className="size-4" /></Tool>
        <EmailButtonDialog editor={editor} open={buttonOpen} onClose={() => setButtonOpen(false)} />
        <Tool title="Divider line" onClick={() => run().insertEmailDivider().run()}><Minus className="size-4" /></Tool>
        <Tool title="Space (vertical gap that every mail client keeps)" onClick={() => run().insertEmailSpacer(24).run()}><MoveVertical className="size-4" /></Tool>
      </Group>

        </div>
      </details>
      {options && <Group label="Options">{options}</Group>}
    </div>
  );
}

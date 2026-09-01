"use client";

import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { Table, TableRow, TableCell, TableHeader } from "@tiptap/extension-table";
import { TextStyle, Color } from "@tiptap/extension-text-style";
import { useEffect, useRef, useState } from "react";
import { TextPromptDialog } from "@/components/TextPromptDialog";
import ModalPortal from "@/components/ui/modal-portal";
import { EmailButton, EmailDivider, EmailSpacer } from "@/components/emailBlockNodes";
import { EMAIL_BUTTON_COLORS } from "@/lib/emailBlockHtml";

const COLORS = ["#1e293b", "#ea580c", "#2563eb", "#059669", "#dc2626"];

function Btn({
  onClick,
  active,
  label,
  title,
}: {
  onClick: () => void;
  active?: boolean;
  label: string;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`rounded px-2 py-1 text-xs font-medium cursor-pointer ${
        active ? "bg-orange-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"
      }`}
    >
      {label}
    </button>
  );
}

/**
 * The CTA-button dialog. Label and URL in one form rather than two chained
 * prompts, plus the brand colour row and alignment — the four things a button
 * has. Editing an existing button reopens the same dialog pre-filled.
 */
function EmailButtonDialog({
  editor,
  open,
  onClose,
}: {
  editor: Editor;
  open: boolean;
  onClose: () => void;
}) {
  // Mounted only while open, so the form below seeds itself from the selected
  // button in its useState INITIALIZERS — fresh state per open, no effect
  // re-seeding state after render, nothing stale on the second open.
  if (!open) return null;
  return <EmailButtonForm editor={editor} onClose={onClose} />;
}

function EmailButtonForm({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const editing = editor.isActive("emailButton");
  const current = editing ? editor.getAttributes("emailButton") : {};
  const [label, setLabel] = useState(String(current.label ?? ""));
  const [url, setUrl] = useState(String(current.url === "#" ? "" : (current.url ?? "")));
  const [color, setColor] = useState<string>(String(current.color ?? EMAIL_BUTTON_COLORS[0]));
  const [align, setAlign] = useState<"left" | "center">(current.align === "left" ? "left" : "center");
  const apply = () => {
    const attrs = { label: label.trim() || "Open", url: url.trim(), color, align };
    if (editing) editor.chain().focus().updateEmailButton(attrs).run();
    else editor.chain().focus().insertEmailButton(attrs).run();
    onClose();
  };
  return (
    <ModalPortal>
      <div className="fixed inset-0 z-[80] grid place-items-center bg-black/60 p-4" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="w-full max-w-sm rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-xl">
          <h3 className="text-sm font-semibold text-slate-100">{editing ? "Edit button" : "Insert button"}</h3>
          <p className="mt-1 text-xs text-slate-400">Sent as an email-safe button that renders in every mail client, Outlook included.</p>
          <label className="mt-3 block text-xs font-medium text-slate-300">Button text</label>
          <input className="input mt-1 w-full" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Book your service" autoFocus />
          <label className="mt-3 block text-xs font-medium text-slate-300">Destination URL</label>
          <input className="input mt-1 w-full" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… or {{portal_link}}" />
          <div className="mt-3 flex items-center justify-between gap-3">
            <div className="flex gap-1.5">
              {EMAIL_BUTTON_COLORS.map((c) => (
                <button key={c} type="button" title={`Button colour ${c}`} onClick={() => setColor(c)} className={`h-6 w-6 rounded border ${color === c ? "border-white ring-1 ring-white" : "border-slate-600"}`} style={{ backgroundColor: c }} />
              ))}
            </div>
            <div className="inline-flex rounded-lg border border-slate-700 p-0.5 text-xs">
              <button type="button" className={`rounded px-2 py-1 ${align === "left" ? "bg-slate-700 text-white" : "text-slate-400"}`} onClick={() => setAlign("left")}>Left</button>
              <button type="button" className={`rounded px-2 py-1 ${align === "center" ? "bg-slate-700 text-white" : "text-slate-400"}`} onClick={() => setAlign("center")}>Centre</button>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="btn-secondary btn-sm" onClick={onClose}>Cancel</button>
            <button type="button" className="btn-primary btn-sm" onClick={apply}>{editing ? "Update button" : "Insert button"}</button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}

function Toolbar({
  editor,
  onImageUpload,
  emailTools,
}: {
  editor: Editor;
  onImageUpload?: (file: File) => Promise<string | null>;
  emailTools?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [buttonDialogOpen, setButtonDialogOpen] = useState(false);
  return (
    <div className="flex flex-wrap gap-1 border-b border-slate-700 bg-slate-900 p-1.5 rounded-t-lg">
      <Btn title="Bold" label="B" active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()} />
      <Btn title="Italic" label="I" active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()} />
      <Btn title="Underline" label="U" active={editor.isActive("underline")} onClick={() => editor.chain().focus().toggleUnderline().run()} />
      <Btn title="Heading" label="H" active={editor.isActive("heading", { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} />
      <span className="w-px bg-slate-700 mx-0.5" />
      <Btn title="Bullet list" label="• List" active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()} />
      <Btn title="Numbered list" label="1. List" active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()} />
      <span className="w-px bg-slate-700 mx-0.5" />
      <TextPromptDialog
        title="Insert link"
        description="Paste the full destination URL."
        label="Link URL"
        defaultValue={editor.getAttributes("link").href ?? "https://"}
        submitLabel="Apply link"
        onSubmit={(url) => { editor.chain().focus().setLink({ href: url }).run(); }}
        trigger={<span><Btn title="Insert link" label="Link" active={editor.isActive("link")} onClick={() => undefined} /></span>}
      />
      {editor.isActive("link") && <Btn title="Remove link" label="Unlink" onClick={() => editor.chain().focus().unsetLink().run()} />}
      <TextPromptDialog
        title="Insert image"
        description="Paste a direct URL for the image."
        label="Image URL"
        placeholder="https://…"
        submitLabel="Insert image"
        onSubmit={(url) => { editor.chain().focus().setImage({ src: url }).run(); }}
        trigger={<span><Btn title="Insert image from URL" label="Image URL" onClick={() => undefined} /></span>}
      />
      {onImageUpload && (
        <>
          <Btn
            title="Upload an image"
            label={uploading ? "…" : "⬆ Upload"}
            onClick={() => fileRef.current?.click()}
          />
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              setUploading(true);
              const url = await onImageUpload(file);
              setUploading(false);
              if (url) editor.chain().focus().setImage({ src: url }).run();
            }}
          />
        </>
      )}
      <Btn
        title="Insert table"
        label="⊞ Table"
        onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
      />
      {editor.isActive("table") && (
        <>
          <Btn title="Add row" label="+Row" onClick={() => editor.chain().focus().addRowAfter().run()} />
          <Btn title="Add column" label="+Col" onClick={() => editor.chain().focus().addColumnAfter().run()} />
          <Btn title="Delete table" label="✕Tbl" onClick={() => editor.chain().focus().deleteTable().run()} />
        </>
      )}
      <span className="w-px bg-slate-700 mx-0.5" />
      {COLORS.map((c) => (
        <button
          key={c}
          type="button"
          title={`Text colour ${c}`}
          onClick={() => editor.chain().focus().setColor(c).run()}
          className="h-6 w-6 rounded cursor-pointer border border-slate-600"
          style={{ backgroundColor: c }}
        />
      ))}
      <Btn title="Clear formatting" label="Tx" onClick={() => editor.chain().focus().clearNodes().unsetAllMarks().run()} />
      {emailTools && (
        <>
          <span className="w-px bg-slate-700 mx-0.5" />
          <Btn
            title={editor.isActive("emailButton") ? "Edit the selected button" : "Insert an email-safe button"}
            label={editor.isActive("emailButton") ? "✎ Button" : "▣ Button"}
            active={editor.isActive("emailButton")}
            onClick={() => setButtonDialogOpen(true)}
          />
          <Btn title="Insert a divider line" label="— Divider" onClick={() => editor.chain().focus().insertEmailDivider().run()} />
          <Btn title="Insert vertical space" label="↕ Spacer" onClick={() => editor.chain().focus().insertEmailSpacer(24).run()} />
          <EmailButtonDialog editor={editor} open={buttonDialogOpen} onClose={() => setButtonDialogOpen(false)} />
        </>
      )}
    </div>
  );
}

export default function RichTextEditor({
  value,
  onChange,
  placeholder,
  onImageUpload,
  onEditorReady,
  emailTools = false,
}: {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  onImageUpload?: (file: File) => Promise<string | null>;
  /**
   * Hands the editor instance to the parent, for the things only an imperative
   * API can do — inserting at the CURSOR being the one that matters.
   *
   * The marketing template screen has "+ First name" buttons that used to append
   * `{{first_name}}` to the end of a plain-text body. Appending to HTML would put
   * the variable after the closing tag rather than where the person is typing, so
   * the button needs to reach the editor rather than the string.
   *
   * Optional, and called with `null` on teardown, so every existing caller is
   * unchanged and a parent holding the reference cannot keep a dead editor.
   */
  onEditorReady?: (editor: Editor | null) => void;
  /**
   * Email building blocks: bulletproof CTA button, divider, spacer.
   *
   * Opt-in per surface, because the blocks emit email-safe TABLE markup —
   * exactly right for anything sent through SMTP, and exactly wrong for any
   * future surface that renders its HTML on the web. Both email surfaces
   * (the 1:1 composer and marketing templates) turn it on.
   */
  emailTools?: boolean;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      TextStyle,
      Color,
      Image,
      Table.configure({ resizable: false }),
      TableRow,
      TableCell,
      TableHeader,
      ...(emailTools ? [EmailButton, EmailDivider, EmailSpacer] : []),
    ],
    content: value,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class:
          // The last four rules: email BLOCKS (button/divider/spacer) are layout
          // tables, so they must not inherit the bordered data-table styling
          // above them, and a selected atom needs a visible outline or clicking
          // it looks like nothing happened.
          "prose-invert min-h-40 max-h-96 overflow-y-auto px-3 py-2 text-sm text-slate-100 outline-none [&_a]:text-orange-400 [&_a]:underline [&_table]:border-collapse [&_td]:border [&_td]:border-slate-600 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-slate-600 [&_th]:px-2 [&_th]:py-1 [&_th]:bg-slate-800 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_h2]:text-lg [&_h2]:font-bold [&_img]:max-w-full [&_table[data-email-block]_td]:!border-0 [&_table[data-email-block]_td]:!px-0 [&_table[data-email-block]_td]:!py-0 [&_.ProseMirror-selectednode]:outline-2 [&_.ProseMirror-selectednode]:outline-dashed [&_.ProseMirror-selectednode]:outline-orange-500",
        "data-placeholder": placeholder ?? "",
      },
    },
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
  });

  // keep external value changes (e.g. template applied) in sync
  useEffect(() => {
    if (editor && value !== editor.getHTML()) {
      editor.commands.setContent(value, { emitUpdate: false });
    }
  }, [value, editor]);

  // Published on mount and RETRACTED on teardown. Without the cleanup a parent
  // would hold a destroyed editor and its next command would throw.
  useEffect(() => {
    if (!onEditorReady) return;
    onEditorReady(editor ?? null);
    return () => onEditorReady(null);
  }, [editor, onEditorReady]);

  if (!editor) {
    return <div className="input min-h-40 animate-pulse" />;
  }

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900 focus-within:border-orange-500">
      <Toolbar editor={editor} onImageUpload={onImageUpload} emailTools={emailTools} />
      <EditorContent editor={editor} />
    </div>
  );
}

"use client";

import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { Table, TableRow, TableCell, TableHeader } from "@tiptap/extension-table";
import { TextStyle, Color } from "@tiptap/extension-text-style";
import { useEffect, useRef, useState } from "react";
import { TextPromptDialog } from "@/components/TextPromptDialog";

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

function Toolbar({
  editor,
  onImageUpload,
}: {
  editor: Editor;
  onImageUpload?: (file: File) => Promise<string | null>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
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
    </div>
  );
}

export default function RichTextEditor({
  value,
  onChange,
  placeholder,
  onImageUpload,
  onEditorReady,
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
    ],
    content: value,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class:
          "prose-invert min-h-40 max-h-96 overflow-y-auto px-3 py-2 text-sm text-slate-100 outline-none [&_a]:text-orange-400 [&_a]:underline [&_table]:border-collapse [&_td]:border [&_td]:border-slate-600 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-slate-600 [&_th]:px-2 [&_th]:py-1 [&_th]:bg-slate-800 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_h2]:text-lg [&_h2]:font-bold [&_img]:max-w-full",
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
      <Toolbar editor={editor} onImageUpload={onImageUpload} />
      <EditorContent editor={editor} />
    </div>
  );
}

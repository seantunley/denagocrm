"use client";

import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { Table, TableRow, TableCell, TableHeader } from "@tiptap/extension-table";
import { TextStyle, Color } from "@tiptap/extension-text-style";
import { useEffect } from "react";

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

function Toolbar({ editor }: { editor: Editor }) {
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
      <Btn
        title="Insert link"
        label="🔗 Link"
        active={editor.isActive("link")}
        onClick={() => {
          const url = window.prompt("Link URL:", editor.getAttributes("link").href ?? "https://");
          if (url === null) return;
          if (url === "") editor.chain().focus().unsetLink().run();
          else editor.chain().focus().setLink({ href: url }).run();
        }}
      />
      <Btn
        title="Insert image from URL"
        label="🖼 Image"
        onClick={() => {
          const url = window.prompt("Image URL:");
          if (url) editor.chain().focus().setImage({ src: url }).run();
        }}
      />
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
}: {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, editor]);

  if (!editor) {
    return <div className="input min-h-40 animate-pulse" />;
  }

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900 focus-within:border-orange-500">
      <Toolbar editor={editor} />
      <EditorContent editor={editor} />
    </div>
  );
}

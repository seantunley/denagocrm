"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect } from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";

/** The actual BlockNote canvas (client-only; loaded dynamically). */
export default function StudioEditorInner({
  initialContent,
  readOnly,
  onChange,
  registerApi,
}: {
  initialContent: unknown;
  readOnly?: boolean;
  onChange: (content: unknown) => void;
  registerApi: (api: { insertToken: (t: string) => void; insertBlocks: (b: unknown) => void }) => void;
}) {
  const editor = useCreateBlockNote({
    initialContent:
      Array.isArray(initialContent) && initialContent.length > 0
        ? (initialContent as any)
        : undefined,
  });

  useEffect(() => {
    registerApi({
      insertToken: (token) => {
        editor.focus();
        editor.insertInlineContent(token);
      },
      insertBlocks: (blocks) => {
        const target = editor.getTextCursorPosition().block;
        editor.insertBlocks(blocks as any, target, "after");
      },
    });
  }, [editor, registerApi]);

  return (
    <BlockNoteView
      editor={editor}
      editable={!readOnly}
      theme="dark"
      onChange={() => onChange(editor.document)}
    />
  );
}
